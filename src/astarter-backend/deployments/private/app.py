"""PRIVATE RPC only; missing configuration stays closed."""
from stark_trading_os.control.private_research_service import create_private_service_from_env

app = create_private_service_from_env()
