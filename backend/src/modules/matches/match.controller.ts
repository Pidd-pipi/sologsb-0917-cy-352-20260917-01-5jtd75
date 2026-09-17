import type { NextFunction, Request, Response } from "express";
import { MatchService } from "./match.service";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "./match.validate";

const service = new MatchService();

export async function createMatch(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rawHeader = request.headers["x-request-id"];
    const requestId = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const view = await service.createMatch(request.body, requestId);
    response.status(201).json({ data: view });
  } catch (error) {
    next(error);
  }
}

export async function correctMatch(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await service.correctMatch(String(request.params.id), request.body);
    response.json({ data: result.view, rolledBack: result.rolledBack });
  } catch (error) {
    next(error);
  }
}

export async function listMatches(
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    response.json({ data: await service.listMatches() });
  } catch (error) {
    next(error);
  }
}

export async function getLeaderboard(
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    response.json(await service.getLeaderboard());
  } catch (error) {
    next(error);
  }
}

export function matchErrorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error instanceof ValidationError) {
    response.status(400).json({ error: "VALIDATION_FAILED", message: error.message, field: error.field });
    return;
  }
  if (error instanceof NotFoundError) {
    response.status(404).json({ error: "NOT_FOUND", message: error.message });
    return;
  }
  if (error instanceof ConflictError) {
    response.status(409).json({ error: "CONFLICT", message: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  response.status(500).json({ error: "INTERNAL_ERROR", message });
}
