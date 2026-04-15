/**
 * Custom error thrown when decryption of a server payload fails due to
 * an encryption key mismatch. Callers must catch this specifically and
 * abort any write-back to the server to prevent data loss.
 */
export class DecryptMismatchError extends Error {
  constructor(message = "Encryption key mismatch: cannot decrypt server payload") {
    super(message);
    this.name = "DecryptMismatchError";
  }
}
