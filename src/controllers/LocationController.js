import {
  createAreaService,
  createDistrictService,
  createDivisionService,
  deleteAreaService,
  deleteDistrictService,
  deleteDivisionService,
  listAreaService,
  listDistrictService,
  listDivisionService,
  updateAreaService,
  updateDistrictService,
  updateDivisionService,
} from "./../services/LocationServices.js";

export const createDivision = async (req, res, next) => {
  const result = await createDivisionService(req, next);
  res.status(200).json(result);
};

export const updateDivision = async (req, res, next) => {
  const result = await updateDivisionService(req, next);
  res.status(200).json(result);
};

export const deleteDivision = async (req, res, next) => {
  const result = await deleteDivisionService(req, next);
  res.status(200).json(result);
};

export const listDivision = async (req, res, next) => {
  const result = await listDivisionService(req, next);
  res.status(200).json(result);
};

//District

export const createDistrict = async (req, res, next) => {
  const result = await createDistrictService(req, next);
  res.status(200).json(result);
};

export const updateDistrict = async (req, res, next) => {
  const result = await updateDistrictService(req, next);
  res.status(200).json(result);
};

export const deleteDistrict = async (req, res, next) => {
  const result = await deleteDistrictService(req, next);
  res.status(200).json(result);
};

export const listDistrict = async (req, res, next) => {
  const result = await listDistrictService(req, next);
  res.status(200).json(result);
};

//Area

export const createArea = async (req, res, next) => {
  const result = await createAreaService(req, next);
  res.status(200).json(result);
};

export const updateArea = async (req, res, next) => {
  const result = await updateAreaService(req, next);
  res.status(200).json(result);
};

export const deleteArea = async (req, res, next) => {
  const result = await deleteAreaService(req, next);
  res.status(200).json(result);
};

export const listArea = async (req, res, next) => {
  const result = await listAreaService(req, next);
  res.status(200).json(result);
};
