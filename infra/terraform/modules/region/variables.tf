variable "name" { type = string }
variable "region" { type = string }
variable "cidr" { type = string }
variable "is_primary" { type = bool }
variable "global_cluster_id" { type = string }
variable "kms_admin_arns" { type = list(string) }
variable "eks_version" {
  type    = string
  default = "1.31"
}
variable "db_instance_class" {
  type    = string
  default = "db.r7g.2xlarge"
}
variable "db_reader_count" {
  type    = number
  default = 2
}
variable "redis_node_type" {
  type    = string
  default = "cache.r7g.large"
}
variable "replica_bucket_arn" {
  type        = string
  default     = null
  description = "Media bucket in the peer region for cross-region replication (DR)."
}
variable "tags" {
  type    = map(string)
  default = {}
}
