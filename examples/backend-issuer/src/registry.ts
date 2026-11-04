import { registryEntry } from './backend.ts';
import { configFromEnv } from './config.ts';

// Prints a registry file trusting this backend's public key (ADR 0005).
console.log(JSON.stringify({ applications: [registryEntry(configFromEnv())] }, null, 2));
