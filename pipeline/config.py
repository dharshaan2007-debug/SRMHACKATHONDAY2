"""
Pipeline configuration for Multi-Hazard Risk Index.
GEE Project: quiet-branch-510205-h9
"""
import numpy as np

# ── Google Earth Engine ──
GEE_PROJECT = "quiet-branch-510205-h9"

# ── Regions ──
REGIONS = {
    "tamil_nadu": {
        "id": "tamil_nadu",
        "name": "Tamil Nadu",
        "bbox": [76.2, 8.0, 80.4, 13.6],   # [west, south, east, north]
        "gaul_name": "Tamil Nadu",           # FAO GAUL Level 1 name
        "gaul_code": None,                   # filled at runtime
        "scale_m": 500,                      # target resolution in meters
        "fallback_scale_m": 1000,            # if a tile times out
        "tile_deg": 1.0,                     # tile size in degrees
        "crs": "EPSG:4326",                  # output CRS for PNGs (web use)
        "output_crs": "EPSG:4326",
    }
}

# ── Hazard factor weights (before AHP normalization) ──
# Flood hazard sub-factors
FLOOD_WEIGHTS = {
    "jrc_occurrence": 0.15,
    "dist_to_water": 0.20,
    "sar_flood_events": 0.20,
    "chirps_heavy_rain": 0.10,
    "relative_elevation": 0.10,
    "absolute_elevation": 0.15,
    "urban_drainage_stress": 0.10,
}

# Landslide hazard sub-factors
LANDSLIDE_WEIGHTS = {
    "slope": 0.40,
    "chirps_heavy_rain": 0.25,
    "landcover_vulnerability": 0.20,
    "ndvi_inverse": 0.15,  # low NDVI = higher hazard
}

# ── AHP pairwise comparison matrix ──
# Order: flood, landslide, slope, exposure
AHP_CRITERIA = ["flood", "landslide", "slope", "exposure"]
AHP_MATRIX = np.array([
    [1,    1,    2,    3],    # flood vs others
    [1,    1,    2,    3],    # landslide vs others
    [1/2,  1/2,  1,    2],   # slope vs others
    [1/3,  1/3,  1/2,  1],   # exposure vs others
])

# Random consistency index for n=4
AHP_RI = {1: 0, 2: 0, 3: 0.58, 4: 0.90, 5: 1.12, 6: 1.24, 7: 1.32, 8: 1.41}

# ── GEE Collection IDs (verified) ──
GEE_COLLECTIONS = {
    "srtm": "USGS/SRTMGL1_003",
    "jrc_surface_water": "JRC/GSW1_4/GlobalSurfaceWater",
    "sentinel1": "COPERNICUS/S1_GRD",
    "chirps_daily": "UCSB-CHG/CHIRPS/DAILY",
    "esa_worldcover": "ESA/WorldCover/v200",
    "modis_ndvi": "MODIS/061/MOD13A1",
    "ghsl_pop": "JRC/GHSL/P2023A/GHS_POP",
    "worldpop": "WorldPop/GP/100m/pop",
    "gaul_level1": "FAO/GAUL/2015/level1",
    "gaul_level2": "FAO/GAUL/2015/level2",
}

# ── Date ranges ──
DATE_RANGES = {
    "sentinel1_monsoon": {
        "years": [2023, 2024, 2025],
        "seasons": [
            {"name": "southwest", "months": [6, 7, 8, 9]},
            {"name": "northeast", "months": [10, 11, 12]},
        ]
    },
    "chirps": {"start": "2020-01-01", "end": "2025-09-30"},
    "modis_ndvi": {"start": "2023-01-01", "end": "2025-09-30"},
    "worldcover": "2021",
    "ghsl_pop": "2020",
}

# ── Normalization ──
PERCENTILE_CLIP = (2, 98)

# ── Risk classification thresholds ──
RISK_CLASSES = {
    "very_low":  (0.0, 0.2),
    "low":       (0.2, 0.4),
    "moderate":  (0.4, 0.6),
    "high":      (0.6, 0.8),
    "very_high": (0.8, 1.0),
}

# ── Demo cache cities (name, lat, lon, radius_m) ──
DEMO_CITIES = [
    ("Chennai",        13.0827,  80.2707, 6000),
    ("Coimbatore",     11.0168,  76.9558, 6000),
    ("Madurai",         9.9252,  78.1198, 6000),
    ("Udhagamandalam", 11.4102,  76.6950, 6000),
    ("Cuddalore",      11.7480,  79.7714, 6000),
]

# ── Output paths ──
DATA_DIR = "data"
PIPELINE_TMP = "pipeline/tmp"
