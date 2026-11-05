# One CloudConnect region: VPC (3 AZ), EKS, Aurora PostgreSQL (global DB member), ElastiCache Redis,
# OpenSearch, S3 media bucket (SSE-KMS, versioned, replicated), and IRSA role for the API.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.80" }
  }
}

data "aws_availability_zones" "az" { state = "available" }
locals {
  azs  = slice(data.aws_availability_zones.az.names, 0, 3)
  tags = merge(var.tags, { "cloudconnect:region" = var.region })
}

resource "aws_kms_key" "main" {
  description             = "${var.name} data encryption (RDS, S3, Redis, OpenSearch, Secrets)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  multi_region            = var.is_primary
  tags                    = local.tags
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.16"

  name                                 = var.name
  cidr                                 = var.cidr
  azs                                  = local.azs
  private_subnets                      = [for i in range(3) : cidrsubnet(var.cidr, 4, i)]
  public_subnets                       = [for i in range(3) : cidrsubnet(var.cidr, 8, 48 + i)]
  database_subnets                     = [for i in range(3) : cidrsubnet(var.cidr, 8, 64 + i)]
  enable_nat_gateway                   = true
  one_nat_gateway_per_az               = true
  enable_dns_hostnames                 = true
  enable_flow_log                      = true
  create_flow_log_cloudwatch_log_group = true
  create_flow_log_cloudwatch_iam_role  = true
  private_subnet_tags                  = { "kubernetes.io/role/internal-elb" = 1, "karpenter.sh/discovery" = var.name }
  public_subnet_tags                   = { "kubernetes.io/role/elb" = 1 }
  tags                                 = local.tags
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.31"

  cluster_name                   = var.name
  cluster_version                = var.eks_version
  vpc_id                         = module.vpc.vpc_id
  subnet_ids                     = module.vpc.private_subnets
  cluster_endpoint_public_access = false
  enable_irsa                    = true
  cluster_encryption_config      = { resources = ["secrets"], provider_key_arn = aws_kms_key.main.arn }
  cluster_enabled_log_types      = ["api", "audit", "authenticator"]
  cluster_addons = {
    coredns = {}, kube-proxy = {}, vpc-cni = {}, aws-ebs-csi-driver = {}, eks-pod-identity-agent = {}
  }
  # Baseline managed node groups; Karpenter handles burst capacity.
  eks_managed_node_groups = {
    system = { instance_types = ["m7g.large"], ami_type = "AL2023_ARM_64_STANDARD", min_size = 3, max_size = 6, desired_size = 3,
    labels = { role = "system" } }
    app = { instance_types = ["c7g.2xlarge", "c7g.4xlarge"], ami_type = "AL2023_ARM_64_STANDARD", capacity_type = "ON_DEMAND",
    min_size = 3, max_size = 150, desired_size = 6, labels = { role = "app" } }
    # Media (LiveKit SFU / RTP) nodes need public IPs for UDP and are tainted for dedicated scheduling.
    media = { instance_types = ["c7gn.2xlarge"], ami_type = "AL2023_ARM_64_STANDARD", min_size = 2, max_size = 80, desired_size = 3,
      subnet_ids = module.vpc.public_subnets, labels = { role = "media" },
    taints = { media = { key = "media", value = "true", effect = "NO_SCHEDULE" } } }
  }
  tags = local.tags
}

# ── Aurora PostgreSQL (member of the global cluster; primary region accepts writes) ──
resource "aws_security_group" "db" {
  name   = "${var.name}-db"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
  tags = local.tags
}

resource "aws_db_subnet_group" "db" {
  name       = var.name
  subnet_ids = module.vpc.database_subnets
}

resource "aws_rds_cluster_parameter_group" "pg" {
  name   = "${var.name}-pg16"
  family = "aurora-postgresql16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements,pg_cron"
    apply_method = "pending-reboot"
  }
}

resource "aws_rds_cluster" "db" {
  cluster_identifier                  = var.name
  engine                              = "aurora-postgresql"
  engine_version                      = "16.4"
  global_cluster_identifier           = var.global_cluster_id
  master_username                     = var.is_primary ? "cloudconnect" : null
  manage_master_user_password         = var.is_primary ? true : null
  database_name                       = var.is_primary ? "cloudconnect" : null
  db_subnet_group_name                = aws_db_subnet_group.db.name
  vpc_security_group_ids              = [aws_security_group.db.id]
  db_cluster_parameter_group_name     = aws_rds_cluster_parameter_group.pg.name
  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.main.arn
  backup_retention_period             = 35
  preferred_backup_window             = "03:00-04:00"
  copy_tags_to_snapshot               = true
  deletion_protection                 = true
  iam_database_authentication_enabled = true
  enabled_cloudwatch_logs_exports     = ["postgresql"]
  skip_final_snapshot                 = false
  final_snapshot_identifier           = "${var.name}-final"
  lifecycle { ignore_changes = [replication_source_identifier, global_cluster_identifier] }
  tags = local.tags
}

resource "aws_rds_cluster_instance" "db" {
  count                           = 1 + var.db_reader_count
  identifier                      = "${var.name}-${count.index}"
  cluster_identifier              = aws_rds_cluster.db.id
  instance_class                  = var.db_instance_class
  engine                          = aws_rds_cluster.db.engine
  engine_version                  = aws_rds_cluster.db.engine_version
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.main.arn
  monitoring_interval             = 15
  auto_minor_version_upgrade      = true
}

# ── Redis (presence, rate limits, socket.io fan-out, queues) ──
resource "aws_elasticache_subnet_group" "redis" {
  name       = var.name
  subnet_ids = module.vpc.private_subnets
}
resource "aws_security_group" "redis" {
  name   = "${var.name}-redis"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
}
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = var.name
  description                = "CloudConnect ${var.region}"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_node_groups            = 3
  replicas_per_node_group    = 1
  automatic_failover_enabled = true
  multi_az_enabled           = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  kms_key_id                 = aws_kms_key.main.arn
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.redis.id]
  snapshot_retention_limit   = 7
  tags                       = local.tags
}

# ── OpenSearch (Elasticsearch-compatible) for global search ──
resource "aws_security_group" "search" {
  name   = "${var.name}-search"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
}
resource "aws_opensearch_domain" "search" {
  domain_name    = var.name
  engine_version = "OpenSearch_2.17"
  cluster_config {
    instance_type          = "r7g.large.search"
    instance_count         = 3
    zone_awareness_enabled = true
    zone_awareness_config { availability_zone_count = 3 }
    dedicated_master_enabled = true
    dedicated_master_type    = "m7g.large.search"
    dedicated_master_count   = 3
  }
  ebs_options {
    ebs_enabled = true
    volume_size = 200
    volume_type = "gp3"
  }
  vpc_options {
    subnet_ids         = module.vpc.private_subnets
    security_group_ids = [aws_security_group.search.id]
  }
  encrypt_at_rest {
    enabled    = true
    kms_key_id = aws_kms_key.main.arn
  }
  node_to_node_encryption { enabled = true }
  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-PFS-2023-10"
  }
  tags = local.tags
}

# ── S3 media (recordings, voicemail, MMS, chat files) ──
resource "aws_s3_bucket" "media" {
  bucket = "${var.name}-media"
  tags   = local.tags
}
resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}
resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    id     = "tiering"
    status = "Enabled"
    filter {}
    transition {
      days          = 30
      storage_class = "INTELLIGENT_TIERING"
    }
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
}
resource "aws_iam_role" "replication" {
  count              = var.replica_bucket_arn == null ? 0 : 1
  name               = "${var.name}-s3-replication"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "s3.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "replication" {
  count = var.replica_bucket_arn == null ? 0 : 1
  role  = aws_iam_role.replication[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetReplicationConfiguration", "s3:ListBucket"], Resource = aws_s3_bucket.media.arn },
    { Effect = "Allow", Action = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"], Resource = "${aws_s3_bucket.media.arn}/*" },
    { Effect = "Allow", Action = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"], Resource = "${var.replica_bucket_arn}/*" },
    { Effect = "Allow", Action = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"], Resource = "*" },
  ] })
}
resource "aws_s3_bucket_replication_configuration" "media" {
  count      = var.replica_bucket_arn == null ? 0 : 1
  depends_on = [aws_s3_bucket_versioning.media]
  bucket     = aws_s3_bucket.media.id
  role       = aws_iam_role.replication[0].arn
  rule {
    id     = "dr"
    status = "Enabled"
    filter {}
    delete_marker_replication { status = "Enabled" }
    source_selection_criteria {
      sse_kms_encrypted_objects { status = "Enabled" }
    }
    destination {
      bucket        = var.replica_bucket_arn
      storage_class = "STANDARD_IA"
      encryption_configuration { replica_kms_key_id = aws_kms_key.main.arn }
    }
  }
}

# ── IRSA role for the API pods (least privilege: media bucket + KMS + its secret) ──
module "api_irsa" {
  source           = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version          = "~> 5.48"
  role_name        = "cloudconnect-api-${var.region}"
  oidc_providers   = { main = { provider_arn = module.eks.oidc_provider_arn, namespace_service_accounts = ["cloudconnect:cloudconnect-api"] } }
  role_policy_arns = { media = aws_iam_policy.api.arn }
}
resource "aws_iam_policy" "api" {
  name = "cloudconnect-api-${var.region}"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.media.arn}/*" },
    { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.main.arn },
    { Effect = "Allow", Action = ["es:ESHttp*"], Resource = "${aws_opensearch_domain.search.arn}/*" },
  ] })
}
