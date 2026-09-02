import { Router } from "express";

import { listPublicProjects } from "../services/projectRegistry.js";

export const projectsRouter = Router();

projectsRouter.get("/", (_req, res) => {
  res.json({ projects: listPublicProjects() });
});
