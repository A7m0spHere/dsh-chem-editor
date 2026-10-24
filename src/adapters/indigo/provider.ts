import { StandaloneStructServiceProvider } from 'ketcher-standalone';

// The browser owns this WASM-backed provider; the Node host never loads it.
export const createStructServiceProvider = () => new StandaloneStructServiceProvider();
