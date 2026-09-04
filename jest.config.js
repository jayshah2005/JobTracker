export default {
  testEnvironment: 'node',
  transform: {},
  moduleFileExtensions: ['js'],
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: ['lib/**/*.js'],
  projects: [
    { displayName: 'node', testMatch: ['**/tests/!(job-extractor).test.js'] },
    {
      displayName: 'jsdom',
      testEnvironment: 'jsdom',
      testMatch: ['**/tests/job-extractor.test.js'],
      setupFiles: ['<rootDir>/tests/setup.js'],
    },
  ],
};
