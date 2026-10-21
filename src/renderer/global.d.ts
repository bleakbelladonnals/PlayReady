import type { LudoReadyApi } from '../shared/contracts';

declare global {
  interface Window {
    ludoready: LudoReadyApi;
    ludoreadyBrowser?: boolean;
  }
}

export {};
