// import libraries
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as rds from "aws-cdk-lib/aws-rds";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets"; // ALBへのエイリアスレコード用

// Stackへ渡すプロパティの型定義
interface WordPressStackProps extends cdk.StackProps {
  domainName?: string;
}

export class WordPressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WordPressStackProps) {
    super(scope, id, props);

    // create VPC
    const vpc = new ec2.Vpc(this, "WordPressVpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
      maxAzs: 2,
      // 学習用ならコスト削減のため natGateways: 1 でも可
      natGateways: 2,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "AppPrivate",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: "DbPrivate",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // ============================================================
    // Security Groups
    // ★変更★ 循環依存を避けるため、SG間のルールは Peer.securityGroupId による
    //         インライン記述ではなく connections API で宣言する方式に変更した。
    //         connections.allowTo は「送信側の egress」と「受信側の ingress」を
    //         CDKが適切な側へ別々に生成するため、SG本体の相互参照が発生しない。
    //         allowAllOutbound は各SGとも元の最小権限設定を維持（変更なし）。
    // ★重要★ ルールの説明文(第3引数)は AWS の制約により ASCII(英数記号)のみ。
    //         日本語を入れると「Invalid rule description」でデプロイ失敗するため英語表記。
    // ============================================================
    // ALB用 SG
    //   インバウンド(80/443)は addListener / addRedirect の open:true が自動で開くため
    //   ここでは手動の addIngressRule は不要。
    const albSg = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc,
      description: "Security Group for ALB",
      allowAllOutbound: false, // ← 変更なし（false のまま維持）
    });

    // EC2用 SG
    const ec2Sg = new ec2.SecurityGroup(this, "Ec2SecurityGroup", {
      vpc,
      description: "Security Group for EC2",
      allowAllOutbound: true, // ← 変更なし
    });

    // RDS用 SG
    // ★変更★ 元はこの位置より後ろ（EC2 SGのルール定義の後）にあったが、
    //         3つのSGを先にまとめて生成し、その後にまとめてルールを張る構成へ整理した。
    const rdsSg = new ec2.SecurityGroup(this, "RdsSecurityGroup", {
      vpc,
      description: "Security Group for RDS",
      allowAllOutbound: false, // ← 変更なし
    });

    // ★変更★ ↓↓ ここから SG間ルールを connections API で宣言（旧 addIngressRule/addEgressRule を置換）↓↓

    // ★変更★ ALB -> EC2 の HTTPS(443)。
    //   【旧】ec2Sg.addIngressRule(Peer.securityGroupId(albSg...), HTTPS) と
    //         albSg.addEgressRule(Peer.securityGroupId(ec2Sg...), HTTPS) の2本
    //   【新】下記1文に統合。egress(ALB側)とingress(EC2側)が別リソースとして張られ循環しない。
    //   ※説明文は ASCII のみ（日本語不可）。
    albSg.connections.allowTo(
      ec2Sg,
      ec2.Port.HTTPS,
      "Allow HTTPS from ALB to EC2"
    );

    // ★変更★ EC2 -> RDS の MySQL(3306)。
    //   【旧】rdsSg.addIngressRule(Peer.securityGroupId(ec2Sg...), MYSQL_AURORA)
    //   【新】connections で宣言（ec2Sgにegress、rdsSgにingressが張られる）。
    //   ※説明文は ASCII のみ（日本語不可）。
    ec2Sg.connections.allowTo(
      rdsSg,
      ec2.Port.MYSQL_AURORA,
      "Allow MySQL from EC2 to RDS"
    );
    // ★変更★ ↑↑ SG間ルールの connections 化ここまで（EICE->EC2 は後段の EICE 定義箇所に記載）↑↑

    // ============================================================
    // EC2 (WordPress) — mod_ssl で 443 待ち受け
    // ============================================================
    const wordpressUserData = ec2.UserData.forLinux();
    wordpressUserData.addCommands(
      "#!/bin/bash",
      // end-to-end TLS: mod_ssl を追加（/etc/httpd/conf.d/ssl.conf が作られ443で待受）
      "dnf install -y httpd wget php-fpm php-mysqli php-json php php-devel mariadb105 mod_ssl",
      // end-to-end TLS: 自己署名証明書を生成（ALBは検証しないのでCN=localhostで十分）
      "openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -keyout /etc/pki/tls/private/localhost.key -out /etc/pki/tls/certs/localhost.crt -subj '/CN=localhost'",
      "wget https://ja.wordpress.org/latest-ja.tar.gz -P /tmp/",
      "tar zxvf /tmp/latest-ja.tar.gz -C /tmp",
      "cp -r /tmp/wordpress/* /var/www/html/",
      "chown apache:apache -R /var/www/html",
      "systemctl enable httpd.service",
      "systemctl start httpd.service"
    );

    const appPrivateSubnets = vpc.selectSubnets({
      subnetGroupName: "AppPrivate",
    });

    const ec2Instance1 = new ec2.Instance(this, "WordPressEc2Az1a", {
      vpc,
      vpcSubnets: { subnets: [appPrivateSubnets.subnets[0]] },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: ec2Sg,
      userData: wordpressUserData,
    });

    const ec2Instance2 = new ec2.Instance(this, "WordPressEc2Az1c", {
      vpc,
      vpcSubnets: { subnets: [appPrivateSubnets.subnets[1]] },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: ec2Sg,
      userData: wordpressUserData,
    });

    const wordpressTargets = [
      new targets.InstanceTarget(ec2Instance1),
      new targets.InstanceTarget(ec2Instance2),
    ];

    // ============================================================
    // ALB -> リスナー -> ターゲットグループ の順で作成
    // ============================================================
    // 1) ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, "WordPressAlb", {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetGroupName: "Public" },
      securityGroup: albSg,
    });

    if (props.domainName) {
      // 登録済みドメインのパブリックホストゾーンを参照（fromLookupはbinでenv指定が必要）
      const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
        domainName: props.domainName,
      });

      // ACM証明書（Route53のDNS検証が自動で通る / クライアント側のTLS終端用）
      const certificate = new acm.Certificate(this, "WordPressCertificate", {
        domainName: props.domainName,
        // www等も使うなら: subjectAlternativeNames: [`www.${props.domainName}`],
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });

      // 2) リスナー（HTTPS:443）。open:true(デフォルト)がALB SGの443インバウンドを自動許可
      const httpsListener = alb.addListener("HttpsListener", {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
      });

      // 3) ターゲットグループ。addTargetsで作成し、上のリスナーのデフォルトに登録
      //    end-to-end TLS なのでバックエンドは HTTPS:443、ヘルスチェックもHTTPS
      httpsListener.addTargets("WordPressTargets", {
        protocol: elbv2.ApplicationProtocol.HTTPS,
        port: 443,
        targets: wordpressTargets,
        healthCheck: {
          path: "/wp-includes/images/blank.gif",
          protocol: elbv2.Protocol.HTTPS,
          healthyHttpCodes: "200",
        },
      });

      // HTTP(80) -> HTTPS(443) リダイレクト。
      //   addRedirectが80リスナーとALB SGの80インバウンド(open:true)を自動作成
      alb.addRedirect(); // デフォルト: HTTP:80 -> HTTPS:443

      // ドメイン -> ALB のエイリアスAレコード（これが無いと名前解決されない）
      new route53.ARecord(this, "AliasRecord", {
        zone: hostedZone,
        // recordName省略でゾーン頂点(apex)。サブドメインなら recordName を指定
        target: route53.RecordTarget.fromAlias(
          new route53Targets.LoadBalancerTarget(alb)
        ),
      });
    } else {
      // ドメイン無しの動作確認用フォールバック（クライアントはHTTP、バックエンドはHTTPS）
      // 2) リスナー（HTTP:80）
      const httpListener = alb.addListener("HttpListener", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
      });

      // 3) ターゲットグループ（バックエンドはHTTPS:443のまま）
      httpListener.addTargets("WordPressTargets", {
        protocol: elbv2.ApplicationProtocol.HTTPS,
        port: 443,
        targets: wordpressTargets,
        healthCheck: {
          path: "/wp-includes/images/blank.gif",
          protocol: elbv2.Protocol.HTTPS,
          healthyHttpCodes: "200",
        },
      });

      new cdk.CfnOutput(this, "HttpsNote", {
        value:
          "domainNameを指定するとACM証明書とRoute53レコードが自動作成されHTTPSが完成します。",
      });
    }

    // ============================================================
    // RDS
    // ============================================================
    const dbSubnetGroup = new rds.SubnetGroup(this, "DbSubnetGroup", {
      vpc,
      description: "RDS SubnetGroup",
      vpcSubnets: { subnetGroupName: "DbPrivate" },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const rdsInstance = new rds.DatabaseInstance(this, "WordPressRds", {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      vpc,
      subnetGroup: dbSubnetGroup,
      securityGroups: [rdsSg],
      multiAz: true,
      databaseName: "wordpress",
      credentials: rds.Credentials.fromGeneratedSecret("wordpress_admin", {
        secretName: "wordpress/rds/credentials",
      }),
      allocatedStorage: 20,
      storageType: rds.StorageType.GP2,
      publiclyAccessible: false,
      backupRetention: cdk.Duration.days(0),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    // ============================================================
    // EC2 Instance Connect Endpoint (SSH用)
    // ============================================================
    const eiceSg = new ec2.SecurityGroup(this, "EiceSg", {
      vpc,
      description: "SecurityGroup for EC2 Instance Connect Endpoint",
      allowAllOutbound: false, // ← 変更なし
    });

    // ★変更★ EICE -> EC2 の SSH(22)。
    //   【旧】eiceSg.addEgressRule(Peer.securityGroupId(ec2Sg...), SSH) と
    //         ec2Sg.addIngressRule(Peer.securityGroupId(eiceSg...), SSH) の2本
    //   【新】下記1文に統合（eiceSgにegress、ec2Sgにingressが張られる）。
    //   ※説明文は ASCII のみ（日本語不可）。
    eiceSg.connections.allowTo(
      ec2Sg,
      ec2.Port.SSH,
      "Allow SSH from EICE to EC2"
    );

    new ec2.CfnInstanceConnectEndpoint(this, "Ec2InstanceConnectEndpoint", {
      subnetId: appPrivateSubnets.subnets[0].subnetId,
      securityGroupIds: [eiceSg.securityGroupId],
      preserveClientIp: false,
    });

    // ============================================================
    // Outputs
    // ============================================================
    new cdk.CfnOutput(this, "AlbDnsName", {
      value: alb.loadBalancerDnsName,
      description: "ALBのDNS名（Route53のAレコードは自動作成済み）",
    });

    new cdk.CfnOutput(this, "RdsSecretArn", {
      value: rdsInstance.secret?.secretArn ?? "(シークレットなし)",
      description: "RDS認証情報のSecrets Manager ARN",
    });

    new cdk.CfnOutput(this, "Ec2Instance1Id", {
      value: ec2Instance1.instanceId,
      description: "EC2-1のID（aws ec2-instance-connect ssh --instance-id <ID>）",
    });
    new cdk.CfnOutput(this, "Ec2Instance2Id", {
      value: ec2Instance2.instanceId,
      description: "EC2-2のID（aws ec2-instance-connect ssh --instance-id <ID>）",
    });
  }
}
