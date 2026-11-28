// GitHub Copilot's device-code sign-in: `copilot login --device-code`, confirmed by the CLI's own exit.
// Copilot CLI 1.0.117 has no `login status` subcommand, so there is no status probe: the device-code command only
// exits 0 once it has stored the token, in the OS credential store or, without one, a plain-text file under
// ~/.copilot/, and SanRemes never holds or writes the token itself. The snapshot probe still checks the sign-in
// the way a turn sees it, after the flow succeeds.
import { stripVTControlCharacters } from "node:util";
import { deviceSignInPrompt } from "../../shared/device-sign-in.ts";
import { DeviceAuthController, type DeviceAuthOptions, type DeviceSignIn } from "./device-auth.ts";

export function copilotDevicePrompt(output: string): { authorizationUrl: string; userCode: string } | null {
  const prompt = deviceSignInPrompt("copilot", stripVTControlCharacters(output));
  return prompt?.userCode ? { authorizationUrl: prompt.authorizationUrl, userCode: prompt.userCode } : null;
}

function loginFailure(output: string): string {
  if (/(unexpected argument|unrecognized (argument|option)|unknown option).*device-code/i.test(output)) {
    return "This server's Copilot CLI needs updating for browser sign-in. Run npm install -g @github/copilot@latest on the server, then try again.";
  }
  if (/already (logged|signed) in/i.test(output)) {
    return "GitHub Copilot is already signed in on this server. Check again to refresh.";
  }
  if (/expired|expiration|timed out/i.test(output)) {
    return "The GitHub sign-in code expired. Start sign-in again for a new code.";
  }
  return "GitHub sign-in did not finish. Check the server's connection, then try again.";
}

export const COPILOT_DEVICE_SIGN_IN: DeviceSignIn = {
  provider: "copilot",
  product: "GitHub Copilot",
  account: "GitHub",
  homeEnv: "COPILOT_HOME",
  homeDir: ".copilot",
  loginArgs: ["login", "--device-code"],
  loginExitConfirms: true,
  install: "Run npm install -g @github/copilot on the server, then try again.",
  failure: loginFailure,
};

export class CopilotDeviceAuthController extends DeviceAuthController {
  constructor(options: DeviceAuthOptions) { super(COPILOT_DEVICE_SIGN_IN, options); }
}
