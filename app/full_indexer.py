"""FullIndex entry point; it shares the PreviewIndex lifecycle with a larger model profile."""
import sys
from .indexer import main


if __name__ == "__main__":
    raise SystemExit(main(indexer_name="FullIndex"))
