export type AzureContainerAppsDiagnosticEvent = {
  timestamp: string;
  event: string;
  details?: Readonly<Record<string, unknown>>;
};

export type AzureContainerAppsDiagnosticLogger = (event: AzureContainerAppsDiagnosticEvent) => void;

export function emitDiagnostic(
  logger: AzureContainerAppsDiagnosticLogger | undefined,
  event: string,
  details?: Readonly<Record<string, unknown>>,
): void {
  if (logger == null) return;

  try {
    logger({
      timestamp: new Date().toISOString(),
      event,
      ...(details == null ? {} : { details }),
    });
  } catch {
    // Diagnostics must never alter sandbox behavior.
  }
}

export function diagnosticError(error: unknown): Record<string, unknown> {
  if (error == null || typeof error !== 'object') return { value: String(error) };

  const candidate = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    statusCode?: unknown;
    serviceError?: unknown;
  };

  return {
    ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
    ...(typeof candidate.message === 'string' ? { message: candidate.message } : {}),
    ...(candidate.code == null ? {} : { code: candidate.code }),
    ...(candidate.statusCode == null ? {} : { statusCode: candidate.statusCode }),
    ...(candidate.serviceError == null ? {} : { serviceError: candidate.serviceError }),
  };
}
