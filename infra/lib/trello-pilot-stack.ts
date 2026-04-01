import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as applicationautoscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import { Construct } from 'constructs';
import * as path from 'path';

const VISIBILITY_TIMEOUT_SECONDS = 3600;
const RETENTION_PERIOD_DAYS = 14;
const DLQ_MAX_RECEIVE_COUNT = 3;
const TASK_CPU = 1024;
const TASK_MEMORY_MIB = 2048;
const AUTOSCALE_MIN_CAPACITY = 0;
const AUTOSCALE_MAX_CAPACITY = 3;
const SCALE_DOWN_COOLDOWN_SECONDS = 300;

export class TrelloPilotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Secrets Manager ──────────────────────────────────────────────
    const secret = new secretsmanager.Secret(this, 'TrelloPilotSecrets', {
      secretName: 'trello-pilot/secrets',
      description: 'Trello Code Pilot worker secrets',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          ANTHROPIC_API_KEY: '',
          GH_TOKEN: '',
          TRELLO_KEY: '',
          TRELLO_TOKEN: '',
          SLACK_WEBHOOK_URL: '',
        }),
        generateStringKey: '_placeholder',
      },
    });

    // ── SQS ──────────────────────────────────────────────────────────
    const deadLetterQueue = new sqs.Queue(this, 'TasksDLQ', {
      queueName: 'trello-pilot-tasks-dlq',
      retentionPeriod: cdk.Duration.days(RETENTION_PERIOD_DAYS),
    });

    const taskQueue = new sqs.Queue(this, 'TasksQueue', {
      queueName: 'trello-pilot-tasks',
      visibilityTimeout: cdk.Duration.seconds(VISIBILITY_TIMEOUT_SECONDS),
      retentionPeriod: cdk.Duration.days(RETENTION_PERIOD_DAYS),
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: DLQ_MAX_RECEIVE_COUNT,
      },
    });

    // ── ECR Repository ───────────────────────────────────────────────
    const ecrRepo = new ecr.Repository(this, 'WorkerRepo', {
      repositoryName: 'trello-pilot-worker',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep last 10 images',
        },
      ],
    });

    // ── VPC ──────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'TrelloPilotVpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // ── ECS Cluster ──────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'TrelloPilotCluster', {
      clusterName: 'trello-pilot',
      vpc,
    });

    // ── ECS Task Definition ──────────────────────────────────────────
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'WorkerTaskDef', {
      cpu: TASK_CPU,
      memoryLimitMiB: TASK_MEMORY_MIB,
    });

    // Grant task role access to SQS
    taskQueue.grantConsumeMessages(taskDefinition.taskRole);
    taskQueue.grantSendMessages(taskDefinition.taskRole);
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['sqs:GetQueueAttributes'],
        resources: [taskQueue.queueArn],
      }),
    );

    // Grant task role access to Secrets Manager
    secret.grantRead(taskDefinition.taskRole);

    // CloudWatch log group
    const logGroup = new logs.LogGroup(this, 'WorkerLogGroup', {
      logGroupName: '/ecs/trello-pilot-worker',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Container definition
    taskDefinition.addContainer('WorkerContainer', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'worker',
      }),
      environment: {
        SQS_QUEUE_URL: taskQueue.queueUrl,
      },
      secrets: {
        ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(secret, 'ANTHROPIC_API_KEY'),
        GH_TOKEN: ecs.Secret.fromSecretsManager(secret, 'GH_TOKEN'),
        TRELLO_KEY: ecs.Secret.fromSecretsManager(secret, 'TRELLO_KEY'),
        TRELLO_TOKEN: ecs.Secret.fromSecretsManager(secret, 'TRELLO_TOKEN'),
        SLACK_WEBHOOK_URL: ecs.Secret.fromSecretsManager(secret, 'SLACK_WEBHOOK_URL'),
      },
    });

    // ── ECS Service ──────────────────────────────────────────────────
    const service = new ecs.FargateService(this, 'WorkerService', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
    });

    // ── Auto Scaling ─────────────────────────────────────────────────
    const scaling = service.autoScaleTaskCount({
      minCapacity: AUTOSCALE_MIN_CAPACITY,
      maxCapacity: AUTOSCALE_MAX_CAPACITY,
    });

    const messagesVisibleMetric = taskQueue.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(1),
      statistic: 'Maximum',
    });

    // Scale up when there are messages in the queue
    scaling.scaleOnMetric('ScaleOnQueueDepth', {
      metric: messagesVisibleMetric,
      scalingSteps: [
        { upper: 0, change: -1 },
        { lower: 1, change: +1 },
        { lower: 5, change: +2 },
      ],
      adjustmentType: applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.seconds(SCALE_DOWN_COOLDOWN_SECONDS),
    });

    // ── Lambda (Webhook Handler) ─────────────────────────────────────
    const webhookHandler = new lambdaNodejs.NodejsFunction(this, 'WebhookHandler', {
      functionName: 'trello-pilot-webhook-handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'lambda', 'webhook-handler', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        externalModules: [],
      },
      environment: {
        SQS_QUEUE_URL: taskQueue.queueUrl,
        BOARD_CONFIG: JSON.stringify({
          todoListIds: [],
          doingListId: '',
          reviewListId: '',
          qaListId: '',
          repoConfig: {
            repoUrl: '',
            baseBranch: 'main',
          },
        }),
      },
    });

    taskQueue.grantSendMessages(webhookHandler);

    // ── API Gateway HTTP API ─────────────────────────────────────────
    const httpApi = new apigatewayv2.HttpApi(this, 'WebhookApi', {
      apiName: 'trello-pilot-webhook',
      description: 'Trello Code Pilot webhook endpoint',
    });

    const lambdaIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'WebhookLambdaIntegration',
      webhookHandler,
    );

    httpApi.addRoutes({
      path: '/webhook',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: lambdaIntegration,
    });

    httpApi.addRoutes({
      path: '/webhook',
      methods: [apigatewayv2.HttpMethod.HEAD],
      integration: lambdaIntegration,
    });

    // ── CloudFormation Outputs ────────────────────────────────────────
    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `${httpApi.apiEndpoint}/webhook`,
      description: 'Trello webhook callback URL',
    });

    new cdk.CfnOutput(this, 'QueueUrl', {
      value: taskQueue.queueUrl,
      description: 'SQS task queue URL',
    });

    new cdk.CfnOutput(this, 'EcrRepoUri', {
      value: ecrRepo.repositoryUri,
      description: 'ECR repository URI for worker image',
    });
  }
}
