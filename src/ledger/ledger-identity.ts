export const ledgerIdentitySeparator = "::";

export function validateLedgerModuleId(moduleId: string): void {
  if (moduleId.includes(":")) {
    throw new Error("ledger module id must not contain reserved separator :");
  }

  validateLedgerPhysicalNamePart("ledger module id", moduleId);
}

export function validateLedgerPhysicalNamePart(
  context: string,
  value: string,
): void {
  if (value.length === 0) {
    throw new Error(`${context} must not be empty`);
  }

  if (value.includes(ledgerIdentitySeparator)) {
    throw new Error(
      `${context} must not contain reserved separator ${ledgerIdentitySeparator}`,
    );
  }
}
