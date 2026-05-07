import { nToHex } from "./nnumberLocal.js";

export function normalizeReg(reg) {
  const s = String(reg || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");

  if (!s.startsWith("N")) {
    const err = new Error("Registration must start with N");
    err.code = "INVALID_REGISTRATION";
    throw err;
  }

  try {
    nToHex(s);
  } catch (e) {
    const err = new Error(String(e.message));
    err.code = "INVALID_REGISTRATION";
    throw err;
  }

  return s;
}

export function lookupAircraft(registration) {
  const reg = normalizeReg(registration);
  const hexUpper = nToHex(reg);

  return {
    registration: reg,
    icao24: hexUpper.toLowerCase(),
    aircraftType: null,
    manufacturer: null,
    sources: [
      {
        name: "faa_mode_s_mapping_local",
        role: "n_number_to_hex_deterministic",
      },
    ],
  };
}
