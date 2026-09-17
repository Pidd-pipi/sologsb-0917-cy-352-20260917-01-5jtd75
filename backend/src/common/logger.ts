export const logger = {
  info(message: string) {
    console.log(`[lpboardgame] ${message}`);
  },
  error(message: string) {
    console.error(`[lpboardgame] ${message}`);
  },
  warn(message: string) {
    console.warn(`[lpboardgame] ${message}`);
  },
};
