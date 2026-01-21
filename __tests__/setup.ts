/**
 * Jest Test Setup
 *
 * This file runs before all tests to configure the testing environment.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from .env file in project root
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Ensure DATABASE_URL is set
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set in environment');
  process.exit(1);
}

if (!process.env.USER_ID) {
  process.env.USER_ID = 'test-user-id';
}

// Increase timeout for database operations
jest.setTimeout(30000);

// Suppress console.log during tests (optional - comment out if you need logs)
// global.console = {
//   ...console,
//   log: jest.fn(),
//   debug: jest.fn(),
//   info: jest.fn(),
//   warn: jest.fn(),
// };
