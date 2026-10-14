import { isAllowedExternalUrl } from "../external-url";
export interface WebHost {
  openUrl(url: string): void;
  note(message: string): void;
}
export const webHost: WebHost = {
  openUrl: (url) => {
    if (isAllowedExternalUrl(url)) window.open(url, "_blank", "noopener,noreferrer");
  },
  note: (message) => {
    console.warn(message);
  },
};
