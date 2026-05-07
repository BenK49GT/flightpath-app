/**
 * Local U.S. N-number <-> ICAO 24-bit hex (Mode S) converter.
 * FAA-style deterministic allocation mapping — no network / API calls.
 * Ported from C:\Users\benku\nnumber-local.js for ESM use in this repo.
 */

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // FAA skips I and O
const L2I = new Map([...LETTERS].map((c, i) => [c, i]));

const HEX_BASE = 0xa00000; // N1 -> A00001

const SUFFIX_CNT = { 1: 601, 2: 601, 3: 601, 4: 25, 5: 1 };

/** @type {Record<number, number>} */
const SUBTREE_CNT = { 5: 1 };
for (let rootLen = 4; rootLen >= 1; rootLen--) {
  SUBTREE_CNT[rootLen] = SUFFIX_CNT[rootLen] + 10 * SUBTREE_CNT[rootLen + 1];
}

const N_RE = /^N([1-9]\d{0,4})([A-HJ-NP-Z]{0,2})$/i;

/**
 * @param {number} rootLen
 * @param {string} suffix
 */
function suffixOffset(rootLen, suffix) {
  if (!suffix) return 0;
  const i1 = L2I.get(suffix[0]);
  if (i1 === undefined) throw new Error(`Invalid suffix letter in registration`);

  if (suffix.length === 1) {
    return 1 + (rootLen === 4 ? i1 : i1 * 25);
  }

  if (rootLen >= 4) {
    throw new Error("Two-letter suffix illegal for 4- or 5-digit roots");
  }
  const i2 = L2I.get(suffix[1]);
  if (i2 === undefined) throw new Error(`Invalid suffix letter in registration`);
  return 2 + i1 * 25 + i2;
}

/**
 * @param {string} nNumber
 * @returns {string} six uppercase hex chars
 */
export function nToHex(nNumber) {
  const m = N_RE.exec(nNumber.trim().toUpperCase());
  if (!m) throw new Error(`Invalid U.S. registration: ${nNumber}`);

  const digits = m[1];
  const suffix = m[2].toUpperCase();
  const rootLen = digits.length;

  if (rootLen === 5 && suffix) throw new Error("5-digit roots cannot have a suffix");
  if (rootLen === 4 && suffix.length > 1) {
    throw new Error("4-digit roots allow at most one letter");
  }

  let idx = (Number(digits[0]) - 1) * SUBTREE_CNT[1];

  let prefixLen = 1;
  for (const dChar of digits.slice(1)) {
    idx += SUFFIX_CNT[prefixLen];
    idx += Number(dChar) * SUBTREE_CNT[prefixLen + 1];
    prefixLen += 1;
  }

  idx += suffixOffset(rootLen, suffix);

  return (HEX_BASE + idx + 1).toString(16).toUpperCase().padStart(6, "0");
}

/**
 * @param {number} rootLen
 * @param {number} off
 */
function offsetToSuffix(rootLen, off) {
  if (off === 0) return "";
  off -= 1;

  if (rootLen === 4) return LETTERS[off];

  const i1 = Math.floor(off / 25);
  const rem = off % 25;
  if (rem === 0) return LETTERS[i1];
  return LETTERS[i1] + LETTERS[rem - 1];
}

/**
 * @param {string} hexCode
 * @returns {string} normalized N-number
 */
export function hexToN(hexCode) {
  let h = hexCode.trim().toUpperCase();
  if (h.startsWith("0X")) h = h.slice(2);
  if (!/^[0-9A-F]{6}$/.test(h)) throw new Error(`Invalid 24-bit hex code: ${hexCode}`);

  const value = parseInt(h, 16);
  if (value < 0xa00001 || value > 0xadf7c7) {
    throw new Error("Hex outside U.S. allocation A00001–ADF7C7");
  }

  let idx = value - HEX_BASE - 1;
  const firstDigit = Math.floor(idx / SUBTREE_CNT[1]);
  idx %= SUBTREE_CNT[1];

  let digitStr = String(firstDigit + 1);
  let prefixLen = 1;

  while (true) {
    if (idx < SUFFIX_CNT[prefixLen]) {
      return "N" + digitStr + offsetToSuffix(prefixLen, idx);
    }

    idx -= SUFFIX_CNT[prefixLen];
    const childSize = SUBTREE_CNT[prefixLen + 1];
    const digit = Math.floor(idx / childSize);
    idx %= childSize;
    digitStr += String(digit);
    prefixLen += 1;
  }
}
