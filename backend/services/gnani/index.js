'use strict';

const gnaniConfig = require('./gnaniConfig');
const gnaniPrivacyPolicy = require('./gnaniPrivacyPolicy');
const interviewQuestions = require('./interviewQuestions');
const timbreService = require('./timbreService');
const prismaService = require('./prismaService');

module.exports = {
  ...gnaniConfig,
  ...gnaniPrivacyPolicy,
  ...interviewQuestions,
  ...timbreService,
  ...prismaService
};
