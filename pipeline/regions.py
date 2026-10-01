"""
Region registry – add new states here to expand coverage.
Each entry maps to a folder under data/<region_id>/.
"""
from config import REGIONS

def get_region(region_id: str) -> dict:
    """Return region config or raise."""
    if region_id not in REGIONS:
        available = ", ".join(REGIONS.keys())
        raise ValueError(f"Unknown region '{region_id}'. Available: {available}")
    return REGIONS[region_id]

def list_regions() -> list:
    """Return list of available region IDs."""
    return list(REGIONS.keys())

if __name__ == "__main__":
    for rid in list_regions():
        r = get_region(rid)
        print(f"  {rid}: {r['name']} bbox={r['bbox']}")
