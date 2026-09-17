import type { NextFunction, Request, Response } from "express";
import type { ErrorRequestHandler } from "express";
import { logger } from "../../common/logger";
import {
  ConflictError,
  NotFoundError,
  StatsConsistencyError,
} from "./record.service";
import { ValidationError } from "./record.validator";

export function asyncHandler(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>
) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response, next).catch(next);
  };
}

export const recordErrorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof ValidationError) {
    response.status(400).json({ error: "VALIDATION_FAILED", message: error.message });
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

  if (error instanceof StatsConsistencyError) {
    // 事务已回滚，对外暴露 500；日志保留以便排查物化视图异常。
    logger.error(`Stats consistency failure: ${error.message}`);
    response.status(500).json({ error: "STATS_INCONSISTENT", message: error.message });
    return;
  }

  logger.error(error instanceof Error ? error.stack ?? error.message : String(error));
  response.status(500).json({ error: "INTERNAL_ERROR", message: "服务内部错误" });
};
