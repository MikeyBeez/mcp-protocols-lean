// Lean protocols server configuration.
// Reads the EXISTING markdown library (read-only). Override with env if you move it.
export const CONFIG = {
  PROTOCOLS_DIR: process.env.PROTOCOLS_DIR || `${process.env.HOME}/Code/mcp-protocols/protocols`,
};
