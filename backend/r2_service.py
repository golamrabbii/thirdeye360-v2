import boto3
import logging
from botocore.exceptions import ClientError
from config import Config

logger = logging.getLogger(__name__)

class R2Service:
    def __init__(self):
        """Initialize R2 client with Cloudflare credentials"""
        try:
            self.s3_client = boto3.client(
                's3',
                endpoint_url=Config.R2_ENDPOINT_URL,
                aws_access_key_id=Config.R2_ACCESS_KEY_ID,
                aws_secret_access_key=Config.R2_SECRET_ACCESS_KEY,
                region_name='auto'  # Cloudflare R2 uses 'auto'
            )
            self.bucket_name = Config.R2_BUCKET_NAME
            logger.info(f"R2 Service initialized with bucket: {self.bucket_name}")
        except Exception as e:
            logger.error(f"Failed to initialize R2 Service: {e}")
            self.s3_client = None
            self.bucket_name = None

    def generate_presigned_url(self, r2_key, expiration_seconds=None):
        """
        Generate a presigned URL for R2 object

        Args:
            r2_key (str): Full R2 object key (e.g., 'track0/0_1.jpg' or 'track0/0_1_comp.jpg')
                         The key should already include the track folder and filename.
            expiration_seconds (int): How long URL is valid (default: from config)

        Returns:
            str: Presigned URL with signature, or None if generation fails
        """
        if not self.s3_client or not r2_key:
            logger.warning(f"Cannot generate URL: r2_key={r2_key}, s3_client={self.s3_client}")
            return None

        try:
            if expiration_seconds is None:
                expiration_seconds = Config.R2_PRESIGNED_URL_EXPIRY

            # r2_key should be the full path like: track0/0_1.jpg or track0/0_1_comp.jpg
            object_key = r2_key

            presigned_url = self.s3_client.generate_presigned_url(
                'get_object',
                Params={'Bucket': self.bucket_name, 'Key': object_key},
                ExpiresIn=expiration_seconds
            )

            logger.debug(f"Generated presigned URL for {object_key}")
            return presigned_url

        except ClientError as e:
            logger.error(f"R2 ClientError generating presigned URL for {r2_key}: {e}")
            return None
        except Exception as e:
            logger.error(f"Unexpected error generating presigned URL for {r2_key}: {e}")
            return None

    def check_connection(self):
        """Test R2 connection by trying to list bucket (or just check if client exists)"""
        if not self.s3_client:
            return False, "R2 client not initialized"

        try:
            # Simple head operation to check connectivity
            # This doesn't require listing permissions
            self.s3_client.head_bucket(Bucket=self.bucket_name)
            return True, "R2 connection successful"
        except ClientError as e:
            logger.warning(f"R2 connection check failed: {e}")
            return False, str(e)
        except Exception as e:
            logger.error(f"R2 connection check error: {e}")
            return False, str(e)

# Singleton instance
r2_service = R2Service()
