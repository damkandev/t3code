import { describe, expect, it } from "vite-plus/test";

import { githubDeviceCode } from "./docker.ts";

describe("githubDeviceCode", () => {
  it("reads the code from gh's device-flow output only once it is complete", () => {
    const output =
      "! First copy your one-time code: AB1C-D2EF\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
    expect(githubDeviceCode(output)).toBe("AB1C-D2EF");
    // Output arrives in chunks; half a code must not be returned.
    expect(githubDeviceCode("! First copy your one-time code: AB1C-D")).toBeNull();
  });
});
