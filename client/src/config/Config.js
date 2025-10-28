const resolveBaseUrl = () => {
  const getRuntimeLocation = () => {
    if (typeof window === "undefined") {
      return null;
    }
    const { protocol, hostname, port } = window.location;
    return { protocol, hostname, port };
  };

  const isLocalHost = (hostname) =>
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";

  const coerceEnvValue = (value, runtimeLocation) => {
    if (!value || !value.trim()) {
      return null;
    }
    const trimmed = value.trim();
    try {
      if (runtimeLocation) {
        const baseOrigin = `${runtimeLocation.protocol}//${runtimeLocation.hostname}${
          runtimeLocation.port ? `:${runtimeLocation.port}` : ""
        }`;
        const parsed = new URL(trimmed, baseOrigin);
        return parsed.origin;
      }
      return new URL(trimmed).origin;
    } catch (error) {
      return trimmed;
    }
  };

  const runtimeLocation = getRuntimeLocation();

  const envValue = coerceEnvValue(
    process.env.NODE_ENV === "production"
      ? process.env.REACT_APP_BASE_URL_PROD
      : process.env.REACT_APP_BASE_URL_DEV,
    runtimeLocation
  );

  if (envValue) {
    let envHostIsLocal = false;
    try {
      envHostIsLocal = isLocalHost(new URL(envValue).hostname);
    } catch (error) {
      envHostIsLocal = false;
    }

    if (runtimeLocation && !isLocalHost(runtimeLocation.hostname) && envHostIsLocal) {
      // Env points to localhost but the current host is remote; fall through.
    } else {
      return envValue;
    }
  }

  if (!runtimeLocation) {
    return "http://localhost:3000";
  }

  const { protocol, hostname, port } = runtimeLocation;

  const buildOrigin = (targetHostname, targetPort = null) => {
    if (targetPort) {
      return `${protocol}//${targetHostname}:${targetPort}`;
    }
    return `${protocol}//${targetHostname}`;
  };

  if (isLocalHost(hostname)) {
    return buildOrigin(hostname, "3000");
  }

  const subdomainMatch = hostname.match(/^(\d+)([-.])(.*)$/);
  if (subdomainMatch) {
    const [, prefix, separator, rest] = subdomainMatch;
    if (prefix === "3001") {
      return buildOrigin(`3000${separator}${rest}`);
    }
  }

  const rewrittenHostname = hostname.replace(/\b3001\b/, "3000");
  if (rewrittenHostname !== hostname) {
    return buildOrigin(rewrittenHostname);
  }

  if (port) {
    if (port === "3001") {
      return buildOrigin(hostname, "3000");
    }
    return buildOrigin(hostname, port);
  }

  return buildOrigin(hostname);
};

const baseUrl = resolveBaseUrl();

if (typeof window !== "undefined") {
  // Log resolved API URL so we can debug environment-specific routing issues.
  // eslint-disable-next-line no-console
  console.log("[Config] Resolved API base URL:", baseUrl);
}

const config = {
  base_url: baseUrl,
};

export default config;
