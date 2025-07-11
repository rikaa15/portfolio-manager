export const logger = {
  log: (message: string) => {
    process.stdout.write(message + '\n');
  },
  warn: (message: string) => {
    process.stdout.write(message + '\n');
  },
  error: (message: string) => {
    process.stderr.write(message + '\n');
  },
};
