import { expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY } from "./csp";

it("allows only the app's own code and the local backend", () => {
  const directives = Object.fromEntries(
    CONTENT_SECURITY_POLICY.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    })
  );
  expect(directives["script-src"]).toEqual(["'self'"]);
  expect(directives["connect-src"]).toEqual(["'self'", "http://127.0.0.1:*"]);
  expect(directives["object-src"]).toEqual(["'none'"]);
  expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-eval/);
});
