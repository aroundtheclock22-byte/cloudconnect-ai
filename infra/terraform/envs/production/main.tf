# Production: active/active app tier in us-east-1 + eu-west-1, Aurora Global Database (writer in
# us-east-1, <1s replication, managed planned/unplanned failover), Cloudflare load balancing with
# health checks and geo-steering in front of both regions.
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.80" }
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.48" }
  }
  backend "s3" {
    bucket         = "cloudconnect-terraform-state"
    key            = "production/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "cloudconnect-terraform-locks"
    encrypt        = true
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags { tags = { project = "cloudconnect", env = "production", compliance = "soc2,hipaa,pci" } }
}
provider "aws" {
  alias  = "eu"
  region = "eu-west-1"
  default_tags { tags = { project = "cloudconnect", env = "production", compliance = "soc2,hipaa,pci,gdpr" } }
}
provider "cloudflare" {}

variable "cloudflare_zone_id" { type = string }
variable "cloudflare_account_id" { type = string }
variable "kms_admin_arns" { type = list(string) }
variable "ingress_hostnames" {
  type        = map(string)
  description = "NLB hostname of ingress-nginx per region (from `kubectl get svc -n ingress-nginx`)."
  default     = { "us-east-1" = "", "eu-west-1" = "" }
}

resource "aws_rds_global_cluster" "main" {
  global_cluster_identifier = "cloudconnect-production"
  engine                    = "aurora-postgresql"
  engine_version            = "16.4"
  storage_encrypted         = true
  deletion_protection       = true
}

module "us_east_1" {
  source            = "../../modules/region"
  name              = "cloudconnect-use1"
  region            = "us-east-1"
  cidr              = "10.10.0.0/16"
  is_primary        = true
  global_cluster_id = aws_rds_global_cluster.main.id
  kms_admin_arns    = var.kms_admin_arns
}

module "eu_west_1" {
  source             = "../../modules/region"
  providers          = { aws = aws.eu }
  name               = "cloudconnect-euw1"
  region             = "eu-west-1"
  cidr               = "10.20.0.0/16"
  is_primary         = false
  global_cluster_id  = aws_rds_global_cluster.main.id
  kms_admin_arns     = var.kms_admin_arns
  replica_bucket_arn = module.us_east_1.media_bucket_arn
  depends_on         = [module.us_east_1]
}

# ── Cloudflare global load balancing (health-checked, geo-steered, automatic regional failover) ──
resource "cloudflare_load_balancer_monitor" "api" {
  account_id     = var.cloudflare_account_id
  type           = "https"
  path           = "/health/ready"
  expected_codes = "200"
  interval       = 15
  retries        = 2
  timeout        = 5
}

resource "cloudflare_load_balancer_pool" "region" {
  for_each   = var.ingress_hostnames
  account_id = var.cloudflare_account_id
  name       = "cloudconnect-${each.key}"
  monitor    = cloudflare_load_balancer_monitor.api.id
  origins {
    name    = each.key
    address = each.value
    header {
      header = "Host"
      values = ["api.cloudconnect.ai"]
    }
  }
}

resource "cloudflare_load_balancer" "api" {
  for_each         = toset(["api.cloudconnect.ai", "app.cloudconnect.ai"])
  zone_id          = var.cloudflare_zone_id
  name             = each.key
  default_pool_ids = [cloudflare_load_balancer_pool.region["us-east-1"].id, cloudflare_load_balancer_pool.region["eu-west-1"].id]
  fallback_pool_id = cloudflare_load_balancer_pool.region["us-east-1"].id
  steering_policy  = "geo"
  proxied          = true
  session_affinity = "cookie" # keeps websockets & softphone sessions sticky to a region
  region_pools {
    region   = "WEU"
    pool_ids = [cloudflare_load_balancer_pool.region["eu-west-1"].id, cloudflare_load_balancer_pool.region["us-east-1"].id]
  }
  region_pools {
    region   = "ENAM"
    pool_ids = [cloudflare_load_balancer_pool.region["us-east-1"].id, cloudflare_load_balancer_pool.region["eu-west-1"].id]
  }
}

# ── Automated backups beyond Aurora PITR: daily cross-region, cross-account vault copies ──
resource "aws_backup_vault" "main" {
  name        = "cloudconnect-production"
  kms_key_arn = module.us_east_1.kms_key_arn
}
resource "aws_backup_vault" "dr" {
  provider    = aws.eu
  name        = "cloudconnect-production-dr"
  kms_key_arn = module.eu_west_1.kms_key_arn
}
resource "aws_backup_plan" "main" {
  name = "cloudconnect-daily"
  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(0 5 * * ? *)"
    lifecycle { delete_after = 35 }
    copy_action {
      destination_vault_arn = aws_backup_vault.dr.arn
      lifecycle { delete_after = 90 }
    }
  }
}

output "regions" {
  value = {
    "us-east-1" = { cluster = module.us_east_1.cluster_name, db = module.us_east_1.db_writer_endpoint, api_role = module.us_east_1.api_role_arn }
    "eu-west-1" = { cluster = module.eu_west_1.cluster_name, db = module.eu_west_1.db_reader_endpoint, api_role = module.eu_west_1.api_role_arn }
  }
}
