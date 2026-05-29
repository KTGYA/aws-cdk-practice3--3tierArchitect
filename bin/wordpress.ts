#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { WordPressStack } from "../lib/wordpress-stack";

const app = new cdk.App();

// ドメイン名は context 経由で指定する。
// 例: cdk deploy -c domainName=your-domain.example
// 未指定の場合は domainName なしでデプロイされる(HTTP動作確認モード)。
const domainName = app.node.tryGetContext("domainName");

new WordPressStack(app, "WordPressStack", {
  domainName,

  // env を明示(route53.HostedZone.fromLookup には具体的な
  // account / region が必須。env未指定だと lookup が失敗する)
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});