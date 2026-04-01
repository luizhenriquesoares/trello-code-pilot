#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TrelloPilotStack } from '../lib/trello-pilot-stack';

const app = new cdk.App();

new TrelloPilotStack(app, 'TrelloPilotStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Trello Code Pilot - AI agent worker infrastructure',
});
