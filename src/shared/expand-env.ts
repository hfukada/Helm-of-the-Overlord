export function expandEnvVars(template: string): string {
  return template.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
    const varName = braced ?? bare;
    const value = process.env[varName];
    if (value === undefined) {
      throw new Error(`Missing environment variable: ${varName}`);
    }
    return value;
  });
}
