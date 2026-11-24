export type ParsedDataRecord =
  | { kind: "none" }
  | { kind: "invalid"; record: string }
  | { kind: "valid"; record: string; values: number[] };

/**
 * Parses one cleaned serial line for a four-DUT DATA record.
 *
 * Returns "none" when the line carries no DATA record, "invalid" when a
 * DATA record is present but malformed, and "valid" with the four ADC
 * values when the record is complete.
 */
export function parseDataRecord(line: string): ParsedDataRecord {
  const dataIndex = line.indexOf("DATA,");
  if (dataIndex < 0) return { kind: "none" };

  const record = line.slice(dataIndex);
  const fields = record.split(",");
  const rawValues = fields.slice(1);
  // Each value must be a non-empty run of digits, exactly what the
  // firmware prints. Number("") is 0, so a bare integer check would turn
  // truncated or garbled records into phantom zero readings.
  if (
    fields.length === 5 &&
    rawValues.every((field) => /^\d+$/.test(field))
  ) {
    return { kind: "valid", record, values: rawValues.map(Number) };
  }
  return { kind: "invalid", record };
}
