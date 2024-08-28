import mongoose from "mongoose";
import UserModel from "./../models/UserModel.js";
import {
  destroyOnCloudinary,
  uploadOnCloudinary,
} from "../utils/CloudinaryUtility.js";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/TokenUtility.js";
import SessionDetailsModel from "../models/SessionDetailsModel.js";
import OtpModel from "./../models/OtpModel.js";
import EmailSend from "../utils/EmailUtility.js";
import {
  afterEmailVerificationTemplate,
  afterResetPasswordTemplate,
  emailVerificationTemplate,
  resetPasswordTemplate,
  restrictAccountTemplate,
  warningAccountTemplate,
} from "../templates/emailTemplates.js";
import dotenv from "dotenv";
import validator from "validator";
import Joi from "joi";
import { inputSanitizer } from "../middlewares/RequestValidateMiddleware.js";
import { currentTime } from "./../constants/CurrectTime.js";
import { fetchLocation } from "../utils/LocationUtility.js";
import { removeUnusedLocalFile } from "../utils/FileCleanUpUtility.js";
import { errorCodes } from "../constants/ErrorCodes.js";
import { otpLinkUtility } from "../utils/OtpLinkUtility.js";
import { emailTypes } from "./../constants/emailTypes.js";
import { calculatePagination } from "../utils/PaginationUtility.js";
import AdminModel from "../models/AdminModel.js";
import { sendNotificationToUser } from "../utils/NotificationsUtility.js";
import { NOTIFICATION_ACTIONS } from "../constants/Notifications.js";
dotenv.config();

const ObjectID = mongoose.Types.ObjectId;

const cleanupLocalFiles = (files) => {
  if (files && files.nidFront) {
    for (const file of files.nidFront) {
      removeUnusedLocalFile(file.path);
    }
  }
  if (files && files.nidBack) {
    for (const file of files.nidBack) {
      removeUnusedLocalFile(file.path);
    }
  }
};

const cleanupCloudinaryFiles = async (responses) => {
  if (responses.nidFrontResponse) {
    await destroyOnCloudinary(responses.nidFrontResponse.public_id);
  }
  if (responses.nidBackResponse) {
    await destroyOnCloudinary(responses.nidBackResponse.public_id);
  }
};

const deleteExistingFiles = async (user) => {
  if (user.nidFront && user.nidFront.pid) {
    await destroyOnCloudinary(user.nidFront.pid);
  }
  if (user.nidBack && user.nidBack.pid) {
    await destroyOnCloudinary(user.nidBack.pid);
  }
};

export const registrationService = async (req, next) => {
  try {
    const reqBody = req.body;

    const user = await UserModel.create(reqBody);

    const emailResponse = await sendAuthEmailsService({
      req,
      emailType: emailTypes.EMAIL_VERIFICATION,
      next,
    });

    if (emailResponse) {
      return {
        status: "success",
        data: user,
        message: "User registered successfully and email sent",
      };
    } else {
      return {
        status: "fail",
        message: "User registered, but email sending failed",
      };
    }
  } catch (error) {
    next(error);
  }
};

export const loginService = async (req, next) => {
  try {
    const reqBody = req.body;
    const user = await UserModel.findOne({
      email: reqBody.email,
    }).exec();

    const isCorrectPassword = await user.isPasswordCorrect(reqBody.password);
    if (!isCorrectPassword) {
      user.loginAttempt += 1;
      await user.save();
      return {
        status: "fail",
        code: errorCodes.AUTHENTICATION_ERROR.code,
        message: errorCodes.AUTHENTICATION_ERROR.message,
      };
    }

    const packet = { _id: user._id, role: user.role };

    const [accessTokenResponse, refreshTokenResponse] = await Promise.all([
      generateAccessToken(packet),
      generateRefreshToken(packet),
    ]);

    // //!!Free limit 45 Fire in a minute, if anything goes wrong check here.
    // Fetch location details based on IP address
    const location = await fetchLocation(req);
    //Set session details to database
    const sessionBody = {
      userID: user._id,
      deviceName: req.headers["user-agent"],
      lastLogin: Date.now(),
      accessToken: accessTokenResponse,
      refreshToken: refreshTokenResponse,
      location: location,
      ipAddress: req.ip,
    };

    const session = await SessionDetailsModel.create(sessionBody);

    if (accessTokenResponse && refreshTokenResponse && session && user) {
      return {
        status: "success",
        id: user._id,
        email: user.email,
        name: user.name,
        accessToken: accessTokenResponse,
        refreshToken: refreshTokenResponse,
      };
    }
    return { status: "fail", message: "Failed to login" };
  } catch (error) {
    next(error);
  }
};

export const profileService = async (req, next) => {
  try {
    let userID = req.headers.id;
    const user = await UserModel.findOne({ _id: userID }).select(
      "-password -sessionId -phoneVerified -nidVerified -emailVerified -accountStatus -warningCount"
    );
    if (!user) {
      return { status: "fail", message: "Failed to load user profile" };
    }
    return { status: "success", data: user };
  } catch (error) {
    next(error);
  }
};

export const updateProfileService = async (req, next) => {
  try {
    //Using fineOne instead of findOneAndUpdate beacuse findOneAndUpdate doesn't trigger the pre "save" which is a must for hashing
    const user = await UserModel.findById(req.headers.id).select("-password");
    if (!user) {
      return { status: "fail", message: "User not found" };
    }
    // Update the user document with values from req.body
    Object.assign(user, req.body);

    const updatedUser = await user.save();

    return {
      status: "success",
      message: "Profile details updated",
      data: updatedUser,
    };
  } catch (error) {
    next(error);
  }
};

export const updatePasswordService = async (req, next) => {
  try {
    const schema = Joi.object().keys({
      currentPassword: Joi.string().required(),
      newPassword: Joi.string().required(),
      confirmPassword: Joi.string().valid(Joi.ref("newPassword")).required(),
    });

    const { error, value } = schema.validate(req.body, { abortEarly: false });
    if (error) {
      return {
        status: "fail",
        message: "Object validation failed",
        error: error,
      };
    }

    const { currentPassword, newPassword } = value;

    const user = await UserModel.findById(req.headers.id).select("password");

    const isCorrectPassword = await user.isPasswordCorrect(currentPassword);
    if (!isCorrectPassword) {
      return { status: "fail", message: "Current passowrd does not matched" };
    }

    user.password = newPassword;

    await user.save();

    return {
      status: "success",
      message: "Password updated",
    };
  } catch (error) {
    next(error);
  }
};

export const updateAvatarService = async (req, next) => {
  let userAvatar = "";
  try {
    let userID = req.headers.id;
    const filePath = req.file.path; //For single file
    if (!filePath) {
      return { status: "fail", message: "No file selected" };
    }

    //Upload on cloudinary
    userAvatar = await uploadOnCloudinary(filePath, req.headers.id);
    const response = await UserModel.findOne({ _id: userID }).exec();

    //At first delete the previous avatar
    if (response.avatar.pid) {
      await destroyOnCloudinary(response.avatar.pid);
    }

    //Set the avatar details to response object
    response.avatar = {
      url: userAvatar.secure_url,
      pid: userAvatar.public_id,
    };

    //Save object to database
    await response.save();

    if (!response) {
      return { status: "fail", message: "Failed to update profile photo" };
    }
    return { status: "success", cloudinary: userAvatar, data: response };
  } catch (error) {
    removeUnusedLocalFile(req.file.path);
    destroyOnCloudinary(userAvatar.public_id);
    next(error);
  }
};

export const updateNidService = async (req, next) => {
  let responses = {};
  try {
    let userID = req.headers.id;
    const filePaths = req.files;

    if (!filePaths) {
      return { status: "fail", message: "No file uploaded" };
    }

    const { nidFront, nidBack } = filePaths;
    if (!nidFront || !nidBack) {
      return { status: "fail", message: "File missing" };
    }

    const user = await UserModel.findOne({ _id: userID }).exec();
    if (!user) {
      return { status: "fail", message: "User not found." };
    }

    if (user.nidSubmitted) {
      cleanupLocalFiles(req.files);
      return {
        status: "fail",
        message: "An approval requests is pending already.",
      };
    }

    await deleteExistingFiles(user);

    responses.nidFrontResponse = await uploadOnCloudinary(
      nidFront[0].path,
      req.headers.id
    );
    responses.nidBackResponse = await uploadOnCloudinary(
      nidBack[0].path,
      req.headers.id
    );

    user.nidFront = {
      url: responses.nidFrontResponse.secure_url,
      pid: responses.nidFrontResponse.public_id,
    };

    user.nidBack = {
      url: responses.nidBackResponse.secure_url,
      pid: responses.nidBackResponse.public_id,
    };

    user.nidSubmitted = true;
    await user.save();

    return { status: "success", data: user };
  } catch (error) {
    cleanupLocalFiles(req.files);
    await cleanupCloudinaryFiles(responses);
    next(error);
  }
};

export const allSessionService = async (req, next) => {
  try {
    const sessions = await SessionDetailsModel.findOne({
      userID: req.headers.id,
    });

    if (!sessions) {
      return { status: "fail", message: "User or session not found" };
    }

    return { status: "success", data: sessions };
  } catch (error) {
    next(error);
  }
};

export const logoutSessionService = async (req, next) => {
  try {
    const response = await SessionDetailsModel.deleteOne({
      _id: req.query.sessionId,
    });

    if (response.deletedCount !== 1) {
      return {
        status: "fail",
        message: "Failed to logout from session.",
      };
    }

    return {
      status: "success",
      message: "Logged out from the session.",
    };
  } catch (error) {
    next(error);
  }
};

export const sendAuthEmailsService = async ({ req, emailType, next }) => {
  try {
    const { email } = req.body;
    const user = await UserModel.findOne({ email }).exec();
    if (!user) {
      return { status: "fail", message: "No registered user found" };
    }
    const { otp, link } = await otpLinkUtility(req, email, user._id, emailType);

    let emailTemplate;

    if (emailType === emailTypes.EMAIL_VERIFICATION) {
      emailTemplate = emailVerificationTemplate({
        name: user.name,
        link: link,
      });
    } else if (emailType === emailTypes.RESET_PASSWORD) {
      emailTemplate = resetPasswordTemplate({
        name: user.name,
        link: link,
        otp: otp,
      });
    }

    if (emailTemplate) {
      const result = await EmailSend(
        email,
        emailTemplate.subject,
        emailTemplate.htmlContent
      );
      if (result) {
        return true;
      } else {
        await UserModel.deleteOne({ email });
        return false;
      }
    }

    return false;
  } catch (error) {
    next(error);
  }
};

export const emailVerificationByLinkService = async (req, next) => {
  try {
    const requestQueryParams = req.query;

    inputSanitizer(requestQueryParams);

    const { userId, token } = requestQueryParams;
    if (!userId || !token) {
      return { status: "fail", message: "Link is invalid or broken" };
    }

    if (!validator.isMongoId(userId) || !validator.isJWT(token)) {
      return { status: "fail", message: "The objects are not valid" };
    }

    const otpRecord = await OtpModel.findOne({
      userID: userId,
      token: token,
      expired: false,
      expiresAt: { $gte: currentTime },
    }).exec();

    if (!otpRecord) {
      return { status: "fail", message: "Invalid or expired token" };
    }

    const user = await UserModel.findOneAndUpdate(
      { _id: userId },
      { emailVerified: true },
      { new: true }
    ).exec();

    if (!user) {
      return { status: "fail", message: "User not found" };
    }

    await OtpModel.deleteMany({ userID: userId });

    const emailTemplateResponse = afterEmailVerificationTemplate({
      name: user.name,
    });

    await EmailSend(
      user.email,
      emailTemplateResponse.subject,
      emailTemplateResponse.htmlContent
    );

    return { status: "success", message: "Email verified successfully" };
  } catch (error) {
    next(error);
  }
};

export const emailVerificationByOtpService = async (req, next) => {
  try {
    const { otp, email } = req.body;

    const otpResponse = await OtpModel.findOne({
      otp,
      email,
      expired: false,
      expiresAt: { $gte: currentTime },
    }).exec();

    if (!otpResponse) {
      return { status: "fail", message: "OTP is invalid or expired" };
    }

    const user = await UserModel.findOneAndUpdate(
      { email: otpResponse.email },
      { emailVerified: true },
      { new: true }
    );

    if (!user) {
      return { status: "fail", message: "User not found" };
    }

    await OtpModel.deleteMany({ userID: user._id });

    const emailTemplateResponse = afterEmailVerificationTemplate({
      name: user.name,
    });

    await EmailSend(
      user.email,
      emailTemplateResponse.subject,
      emailTemplateResponse.htmlContent
    );

    return { status: "success", message: "OTP verified successfully" };
  } catch (error) {
    next(error);
  }
};

export const verifyResetPasswordTokenService = async (req, next) => {
  try {
    const { userId, token } = req.query;

    if (!validator.isMongoId(userId) || !validator.isJWT(token)) {
      return { status: "fail", message: "The objects are not valid" };
    }

    const user = await UserModel.findById(userId).exec();

    if (!user) {
      return { status: "fail", message: "User not found" };
    }

    const validToken = await OtpModel.findOne({
      userID: userId,
      email: user.email,
      token: token,
      expired: false,
      expiresAt: { $gte: currentTime },
    }).exec();

    if (validToken) {
      return true;
    }
    return false;
  } catch (error) {
    next(error);
  }
};
export const resetPasswordByLinkService = async (req, next) => {
  try {
    const { userId, token } = req.query;
    const { newPassword, confirmPassword } = req.body;

    if (newPassword !== confirmPassword) {
      return { status: "fail", message: "Password didn't matched" };
    }
    const user = await UserModel.findById(userId).exec();

    if (!user) {
      return { status: "fail", message: "User not found" };
    }

    const validToken = await OtpModel.findOne({
      userID: userId,
      email: user.email,
      token,
      expired: false,
      expiresAt: { $gte: currentTime },
    }).exec();

    if (!validToken) {
      return { status: "fail", message: "Token is invalid or expired" };
    }

    user.password = newPassword;
    await user.save();

    await OtpModel.deleteMany({ userID: userId });

    const location = await fetchLocation(req);

    const userAgent = req.useragent;

    const emailTemplateResponse = afterResetPasswordTemplate({
      name: user.name,
      ip: req.headers["x-forwarded-for"],
      location: location,
      device: userAgent.platform,
      time: new Date().toLocaleString("en-NZ", { timeZone: "Asia/Dhaka" }),
    });

    await EmailSend(
      user.email,
      emailTemplateResponse.subject,
      emailTemplateResponse.htmlContent
    );

    return { status: "success", message: "Password changed successfully" };
  } catch (error) {
    console.log(error);
    next(error);
  }
};

export const resetPasswordByOtpService = async (req, next) => {
  try {
    const requestBody = req.body;
    inputSanitizer(requestBody);

    const schema = Joi.object()
      .keys({
        email: Joi.string().email().required(),
        otp: Joi.number().max(999999).required(),
        newPassword: Joi.string().required(),
        confirmPassword: Joi.string().valid(Joi.ref("newPassword")).required(),
      })
      .with("newPassword", "confirmPassword");

    const { error, value } = schema.validate(requestBody, {
      abortEarly: false,
    });
    if (error) {
      return {
        status: "fail",
        message: "Object validation failed",
        error: error,
      };
    }

    const { email, otp, newPassword, confirmPassword } = value;

    if (newPassword !== confirmPassword) {
      return { status: "fail", message: "Password didn't matched" };
    }

    let otpResponse = await OtpModel.findOne({
      email: email,
      otp: otp,
      expired: false,
      expiresAt: { $gte: currentTime },
    }).exec();

    if (!otpResponse) {
      return { status: "fail", message: "Otp is invalid or expired" };
    }

    let user = await UserModel.findOneAndUpdate(
      { email: email },
      { $set: { password: newPassword } },
      {
        new: true,
      }
    );

    if (!user) {
      return { status: "fail", message: "Password reset failed" };
    }

    await OtpModel.deleteMany({ email: email });

    const location = await fetchLocation(req);

    const userAgent = req.useragent;

    const emailTemplateResponse = afterResetPasswordTemplate({
      name: user.name,
      ip: req.headers["x-forwarded-for"],
      location: location,
      device: userAgent.platform,
      time: new Date().toLocaleString("en-NZ", { timeZone: "Asia/Dhaka" }),
    });

    await EmailSend(
      user.email,
      emailTemplateResponse.subject,
      emailTemplateResponse.htmlContent
    );

    return { status: "success", message: "Password reset successfully" };
  } catch (error) {
    next(error);
  }
};

//_____Admin______
export const getUserListService = async (req, next) => {
  try {
    let query = {};
    const { status, page, limit, sortBy, sortOrder } = req.query;
    const pagination = calculatePagination({
      page,
      limit,
      sortBy,
      sortOrder,
    });

    //Admin can search user by their account status also
    if (status) {
      query.accountStatus = status;
    }

    const totalUser = await UserModel.countDocuments(query);

    const data = await UserModel.find(query)
      .sort({ [pagination.sortBy]: pagination.sortOrder === "desc" ? -1 : 1 })
      .limit(pagination.limit)
      .skip(pagination.skip)
      .select("-password");

    if (!data) {
      return { status: "fail", message: "Failed to load user list" };
    }
    return {
      status: "success",
      total: totalUser,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        totalPages: Math.ceil(totalUser / pagination.limit),
      },
      data: data,
    };
  } catch (error) {
    next(error);
  }
};

export const withdrawRestrictionsService = async (req, next) => {
  try {
    const data = await UserModel.findOneAndUpdate(
      { _id: req.params.userId },
      { $set: { accountStatus: "Validate" } },
      { new: true }
    );
    if (!data) {
      return { status: "fail", message: "Failed to withdraw restriction" };
    }
    return { status: "success", data: data };
  } catch (error) {
    next(error);
  }
};

export const warningAccountService = async (req, next) => {
  try {
    const { userId } = req.params;
    const data = await UserModel.findOneAndUpdate(
      { _id: userId },
      { $set: { accountStatus: "Warning" }, $inc: { warningCount: 1 } },
      { new: true }
    );
    if (!data) {
      return { status: "fail", message: "Failed to warning account" };
    }

    const adminResponse = await AdminModel.findOneAndUpdate(
      { _id: req.headers.id },
      { $addToSet: { warnedAccounts: userId } }
    );
    if (!adminResponse) {
      return {
        status: "fail",
        message: "Failed to warning account, check admin model",
      };
    }

    await sendNotificationToUser({
      action: NOTIFICATION_ACTIONS.WARNING_ACCOUNT,
      userId: userId,
      senderId: req.headers.id,
    });

    const emailTemplate = warningAccountTemplate({ name: data.name });
    await EmailSend(
      data.email,
      emailTemplate.subject,
      emailTemplate.htmlContent
    );

    return { status: "success", data: data };
  } catch (error) {
    next(error);
  }
};

export const restrictAccountService = async (req, next) => {
  try {
    const { userId } = req.params;
    const data = await UserModel.findOneAndUpdate(
      { _id: userId },
      { $set: { accountStatus: "Restricted" } },
      { new: true }
    );
    if (!data) {
      return { status: "fail", message: "Failed to restrict account" };
    }

    const adminResponse = await AdminModel.findOneAndUpdate(
      { _id: req.headers.id },
      { $addToSet: { restrictedAccounts: userId } }
    );
    if (!adminResponse) {
      return {
        status: "fail",
        message: "Failed to restrict account, check admin model",
      };
    }

    //Send email
    const emailTemplate = restrictAccountTemplate({ name: data.name });
    await EmailSend(
      data.email,
      emailTemplate.subject,
      emailTemplate.htmlContent
    );
    return { status: "success", data: data };
  } catch (error) {
    next(error);
  }
};

export const getReviewNidListService = async (req, next) => {
  try {
    const { page, limit, sortBy, sortOrder } = req.query;

    const pagination = calculatePagination({
      page,
      limit,
      sortBy,
      sortOrder,
    });

    const totalCount = await UserModel.countDocuments({
      nidSubmitted: true,
      nidFront: { $exists: true, $ne: null },
      nidBack: { $exists: true, $ne: null },
    });

    const data = await UserModel.find({
      nidSubmitted: true,
      nidFront: { $exists: true, $ne: null },
      nidBack: { $exists: true, $ne: null },
    })
      .sort({ [pagination.sortBy]: pagination.sortOrder === "desc" ? -1 : 1 })
      .limit(pagination.limit)
      .skip(pagination.skip)
      .select("_id name email nidFront nidBack");

    if (!data) {
      return {
        status: "fail",
        message: "Failed to load review nid list",
      };
    }

    return {
      status: "success",
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        totalPages: Math.ceil(totalCount / pagination.limit),
      },
      data: data,
    };
  } catch (error) {
    next(error);
  }
};

export const approveNidService = async (req, next) => {
  try {
    let userID = req.params.userId;
    const data = await UserModel.findOneAndUpdate(
      {
        _id: userID,
        nidSubmitted: true,
        nidFront: { $exists: true, $ne: null },
        nidBack: { $exists: true, $ne: null },
      },
      {
        $set: {
          nidVerified: true,
        },
      },
      { new: true }
    );

    if (!data) {
      return {
        status: "fail",
        message: "User or user's NID not found",
      };
    }

    return {
      status: "success",
      message: "NID requests Approved",
      data: data,
    };
  } catch (error) {
    next(error);
  }
};

export const declineNidService = async (req, next) => {
  try {
    let userID = req.params.userId;
    const data = await UserModel.findOneAndUpdate(
      {
        _id: userID,
        nidSubmitted: true,
        nidFront: { $exists: true, $ne: null },
        nidBack: { $exists: true, $ne: null },
      },
      {
        $set: {
          nidVerified: false,
          nidSubmitted: false,
          nidFront: "",
          nidBack: "",
        },
      },
      { new: true }
    );

    if (!data) {
      return {
        status: "fail",
        message: "User or user's NID not found",
      };
    }

    return {
      status: "success",
      message: "NID requests Declined",
      data: data,
    };
  } catch (error) {
    next(error);
  }
};

export const searchUserService = async (req, next) => {
  try {
    const { user, page, limit, sortBy, sortOrder } = req.query;

    const pagination = calculatePagination({
      page,
      limit,
      sortBy,
      sortOrder,
    });

    const response = await UserModel.aggregate([
      {
        $match: {
          $or: [
            { name: { $regex: user, $options: "i" } },
            { phone: { $regex: user, $options: "i" } },
          ],
        },
      },
      {
        $sort: {
          [pagination.sortBy]: pagination.sortOrder === "desc" ? -1 : 1,
        },
      },
      {
        $facet: {
          totalCount: [{ $count: "count" }],
          paginatedResults: [
            { $limit: pagination.limit },
            { $skip: pagination.skip },
            {
              $project: {
                password: 0,
                sessionId: 0,
              },
            },
          ],
        },
      },
    ]);

    if (!response) {
      return { status: "fail", message: "No account found" };
    }

    const { totalCount, paginatedResults } = response[0];
    const totalItems = totalCount.length > 0 ? totalCount[0].count : 0;

    return {
      status: "success",
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        totalPages: Math.ceil(totalItems / pagination.limit),
      },
      data: paginatedResults,
    };
  } catch (error) {
    next(error);
  }
};
