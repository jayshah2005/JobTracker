export default {
  testEnvironment: 'node',
  transform: {},
  moduleFileExtensions: ['js'],
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: ['lib/**/*.js'],
  projects: [
    {
      displayName: 'node',
      testMatch: ['**/tests/!(job-extractor|extractors-ats|posted-date|role-company-split).test.js'],
    },
    {
      displayName: 'jsdom',
      testEnvironment: 'jsdom',
      testMatch: [
        '**/tests/job-extractor.test.js',
        '**/tests/extractors-ats.test.js',
        '**/tests/posted-date.test.js',
        '**/tests/role-company-split.test.js',
      ],
      setupFiles: ['<rootDir>/tests/setup.js'],
    },
  ],
};
