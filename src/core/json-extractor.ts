/**
 * Extract JSON from a Claude response that may contain markdown fences and extra text.
 * Handles patterns like:
 *   ```json\n{...}\n```\nSome extra text...
 *   {"key": "value"}
 *   Some text {"key": "value"} more text
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();

  // Try to extract from markdown code fence
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(trimmed);
  if (fenceMatch !== null && fenceMatch[1] !== undefined) {
    return fenceMatch[1].trim();
  }

  // Try to extract raw JSON object
  const objectMatch = /(\{[\s\S]*\})/.exec(trimmed);
  if (objectMatch !== null && objectMatch[1] !== undefined) {
    return objectMatch[1].trim();
  }

  // Return as-is
  return trimmed;
}
