import os

if os.environ.get("VERCEL_ENV") == "preview" or os.environ.get("ASTARTER_PUBLIC_PREVIEW_CONFIG"):
    from cloud_preview import create_preview_app
    app = create_preview_app()
else:
    from cloud import create_app
    app = create_app()
