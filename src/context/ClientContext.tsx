// The client state moved to a zustand store (`../state/Client`); this re-export keeps the old
// import path working for existing call sites. No provider needed any more.
export { useClient } from "../state/Client";
