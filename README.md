## 3層アーキテクチャをCDKで再構築。

ALB + EC2+ RDS(Multi-AZ) による3層構成のWordPressを AWS CDK (TypeScript) でdeploy。
Route53、ACM、HTTPS、EC2、VPC,

※ [3層アーキテクチャをコンソールで構築したハンズオン記事](https://zenn.dev/kou_y/articles/fe82ded346aece) を CDKで再構築したもの。

## 構成概要

- **VPC**: 2 AZ。パブリック/アプリ用プライベート(Egressあり)/DB用プライベート(Isolated)の3層サブネット
- **ALB**: EC2へのアクセスをALBに集約することで管理しやすく。EC2の負荷分散も。
- **EC2 × 2**: 各AZのプライベートサブネット（PRIVATE＿WITH_EGRESS）に配置。
- **RDS (MySQL 8.0)**: Multi-AZ。Isolatedサブネットに配置。認証情報は Secrets Manager で自動生成。
- **Route53 + ACM**: Route53でドメイン作成（、その際にホストゾーンも自動作成）、それをACMと紐づけ。
- **EC2 Instance Connect Endpoint**: プライベートEC2への SSH 用（踏み台不要）
- **NAT Gateway × 2**: プライベートEC2のアウトバウンド用（WordPressの更新等を想定）

## ディレクトリ構成（生成AIに構成を見せて作成）

※`cdk init app --language typescript` のデフォルトから変更したのは **`bin/` と `lib/` の2ファイルのみ**です。
その他（`cdk.json` / `package.json` / `tsconfig.json` / `jest.config.js` / `test/`）はデフォルトのまま使用しています。

```
.
├── bin/
│   └── wordpress.ts          # ★ domainName と env を追加（その他はデフォルト）
├── lib/
│   └── wordpress-stack.ts    # ★ スタック本体
├── test/                     # デフォルト
├── cdk.json                  # デフォルト
├── package.json              # デフォルト
├── tsconfig.json             # デフォルト
└── README.md
```

## 前提条件

- AWS アカウントと、認証情報を設定済みの AWS CLI
- Node.js / AWS CDK v2 (`npm install -g aws-cdk`)
- **Route53 でドメインを登録済み**であること
　（CDKではRoute53のドメイン登録できないので、コンソールで事前に実施しています。
　　ドメイン作成の際に、ホストゾーンは自動で作成されます。）

## セットアップ & デプロイ

```bash
# 1. 依存パッケージのインストール
npm install

# 2. CDK ブートストラップ（アカウント×リージョンごとに初回のみ）
cdk bootstrap

# 3. ドメインを指定してデプロイ
#    bin/wordpress.ts のデフォルト値を書き換えるか、-c で渡します
cdk deploy -c domainName=example.com（仮のアドレスです。）
```

## デプロイ後の作業（WordPress 初期設定）
※[AWSハンズオンのHP](https://catalog.us-east-1.prod.workshops.aws/workshops/47782ec0-8e8c-41e8-b873-9da91e822b36/ja-JP/hands-on/phase5)より。

ユーザーデータはWordPressのHPまで飛ぶことができますが、初回設定は手動での対応が必要です。
上記リンクを参照してください。

## 主な出力（Outputs）

| 出力名 | 内容 |
| --- | --- |
| `AlbDnsName` | ALB の DNS 名（Route53 A レコードは自動作成済み） |
| `RdsSecretArn` | RDS 認証情報が入った Secrets Manager の ARN |
| `Ec2Instance1Id` / `Ec2Instance2Id` | 各 EC2 のインスタンス ID（SSH 用） |


## 後片付け（削除）

```bash
cdk destroy
```
※Route53など手動で作成したものがあれば、このコマンドで削除されないので手動での削除が必要です。
　またその他リソースも削除されているかはコンソール等での確認を推奨しています。

## 感想
一度構築した構成だったので、CDKのコーディングに集中できた。
プロパティ、メソッド、クラス等を調べながらだったが、完走できてよかった。
網羅的に覚えるのは難しいので、アウトプットを増やしながら自分の引き出しも増やしていきたい。

GitHubへの公開も前よりはスムーズにできたが、やっぱり理解が全然追い付いていない。
これもやりながら覚えていく。
