import {
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  CfnOutput,
  CfnParameter
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as amplify from "aws-cdk-lib/aws-amplify";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";

/**
 * NOTE:
 * Bedrock Knowledge Bases + OpenSearch Serverless resources are currently best
 * modeled via L1 CloudFormation resources. This stack lays down the core API + Lambda
 * and placeholders for KB wiring; you’ll fill KB/OSS details once account/region
 * specifics are confirmed.
 */
export class AdaptiveGamingChatbotStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const bedrockModelArn = this.node.tryGetContext("bedrockModelArn") as string | undefined;

    const bedrockModelId =
      this.node.tryGetContext("bedrockModelId") ??
      "amazon.nova-lite-v1:0";

    // Knowledge Base ID is provided post-deployment after the KB is created manually.
    // Set via Lambda environment variable update once the KB is ready.
    const bedrockKbId = this.node.tryGetContext("bedrockKbId") as string ?? "";

    const agentFn = new lambda.Function(this, "AiAgentFn", {
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset("lambda/ai-agent"),
      handler: "handler.handler",
      timeout: Duration.seconds(60),
      memorySize: 1024,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        BEDROCK_KB_ID: bedrockKbId,
        BEDROCK_MODEL_ID: bedrockModelId,
        BEDROCK_MODEL_ARN: bedrockModelArn?.trim() ? bedrockModelArn.trim() : ""
      }
    });

    // Lambda only queries Bedrock; no direct read access is needed.

    // Permissions for Bedrock Agent Runtime (KB retrieval+generation).
    agentFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:Retrieve",
          "bedrock:RetrieveAndGenerate",
          "bedrock:InvokeModel",
          "bedrock:GetInferenceProfile",
          "bedrock:ListInferenceProfiles"
        ],
        resources: ["*"]
      })
    );

    const httpApi = new apigwv2.HttpApi(this, "ChatApi", {
      corsPreflight: {
        allowCredentials: false,
        allowHeaders: ["content-type"],
        allowMethods: [apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.OPTIONS],
        allowOrigins: ["*"]
      }
    });

    // Apply default throttling to protect against abuse and runaway Bedrock costs
    const defaultStageOptions = httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    if (defaultStageOptions) {
      defaultStageOptions.defaultRouteSettings = {
        throttlingBurstLimit: 20,
        throttlingRateLimit: 10
      };
    }

    const httpAccessLogs = new logs.LogGroup(this, "ChatApiAccessLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY
    });
    const defaultStage = httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    if (defaultStage) {
      defaultStage.accessLogSettings = {
        destinationArn: httpAccessLogs.logGroupArn,
        format: JSON.stringify({
          requestId: "$context.requestId",
          httpMethod: "$context.httpMethod",
          path: "$context.path",
          status: "$context.status",
          responseLength: "$context.responseLength"
        })
      };
    }

    httpApi.addRoutes({
      path: "/api/chat",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "ChatIntegration",
        agentFn
      )
    });

    // Read Amplify config from CDK context (passed via -c flags in buildspec)
    const amplifyRepo = this.node.tryGetContext("amplifyRepository") as string;
    const amplifyOauthToken = this.node.tryGetContext("amplifyOauthToken") as string;
    const amplifyBranchName = this.node.tryGetContext("amplifyBranch") as string ?? "main";

    const amplifyRole = new iam.Role(this, "AmplifyServiceRole", {
      assumedBy: new iam.ServicePrincipal("amplify.amazonaws.com")
    });
    amplifyRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess-Amplify")
    );

    const amplifyApp = new amplify.CfnApp(this, "AdaptiveGamingAmplifyApp", {
      name: "adaptive-gaming-guide",
      repository: amplifyRepo,
      oauthToken: amplifyOauthToken,
      platform: "WEB",
      iamServiceRole: amplifyRole.roleArn,
      environmentVariables: [
        {
          name: "NEXT_PUBLIC_API_URL",
          value: httpApi.apiEndpoint
        }
      ]
    });

    new amplify.CfnBranch(this, "AdaptiveGamingAmplifyBranch", {
      appId: amplifyApp.attrAppId,
      branchName: amplifyBranchName,
      enableAutoBuild: true
    });

    httpApi.addRoutes({
      path: "/api/chat",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "ChatGetIntegration",
        agentFn
      )
    });

    httpApi.addRoutes({
      path: "/health",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "HealthIntegration",
        agentFn
      )
    });

    httpApi.addRoutes({
      path: "/",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "RootIntegration",
        agentFn
      )
    });

    new CfnOutput(this, "HttpApiUrl", {
      value: httpApi.apiEndpoint
    });
    new CfnOutput(this, "AmplifyAppId", {
      value: amplifyApp.attrAppId
    });
    new CfnOutput(this, "BedrockKbIdNote", {
      value: "Set BEDROCK_KB_ID on the Lambda function after creating your Knowledge Base manually.",
      description: "Post-deployment: update Lambda env var BEDROCK_KB_ID with your KB ID"
    });
  }
}


