#!/usr/bin/env python3
"""
Generate synthetic but plausible hazard rasters for Tamil Nadu when GEE is not available.
Uses mathematical models based on geographic patterns:
- Flood: higher near coast, river deltas, low elevation
- Landslide: higher in Western Ghats (high slope, western TN)
- Slope: derived from lon/lat patterns matching real terrain
- Population: higher in cities (Chennai, Coimbatore, Madurai, etc.)
"""

import json
import math
import os
import numpy as np
from PIL import Image
from datetime import datetime

# Tamil Nadu bbox
BBOX = [76.2, 8.0, 80.4, 13.6]
SCALE_DEG = 500 / 111000  # ~500m in degrees
WIDTH = int((BBOX[2] - BBOX[0]) / SCALE_DEG)
HEIGHT = int((BBOX[3] - BBOX[1]) / SCALE_DEG)

# Limit to reasonable size
WIDTH = min(WIDTH, 940)
HEIGHT = min(HEIGHT, 1244)

print(f"Raster size: {WIDTH}x{HEIGHT}")

# Tamil Nadu approximate boundary (simplified polygon for masking)
# Major cities for population weighting
CITIES = [
    (13.08, 80.27, 0.95, 25),  # Chennai
    (11.02, 76.96, 0.70, 15),  # Coimbatore
    (9.93, 78.12, 0.65, 15),   # Madurai
    (10.79, 78.69, 0.50, 12),  # Trichy
    (11.94, 79.81, 0.45, 10),  # Pondicherry
    (8.18, 77.41, 0.40, 12),   # Tirunelveli
    (11.66, 78.16, 0.45, 10),  # Salem
    (11.34, 77.73, 0.50, 10),  # Erode
    (10.36, 77.97, 0.40, 8),   # Dindigul
    (12.92, 79.13, 0.35, 8),   # Vellore
    (10.77, 79.14, 0.35, 8),   # Thanjavur
    (9.28, 79.14, 0.30, 8),    # Ramanathapuram
    (11.75, 79.77, 0.45, 10),  # Cuddalore
    (8.73, 77.69, 0.35, 8),    # Thoothukudi
    (12.52, 80.18, 0.35, 8),   # Kanchipuram
]

def in_tamil_nadu(lat, lon):
    """Rough check if point is within Tamil Nadu state boundary."""
    # Simplified boundary check
    if lon < 76.3 or lon > 80.35:
        return False
    if lat < 8.05 or lat > 13.55:
        return False
    # Western boundary curves
    if lat > 12.0 and lon < 77.5:
        return False
    if lat > 11.0 and lon < 76.4:
        return False
    if lat < 8.5 and lon < 77.0:
        return False
    # Sri Lanka gap
    if lat < 9.5 and lon > 79.8:
        return False
    if lat < 10.0 and lon > 80.0:
        return False
    # Coastal cutoff (Bay of Bengal)
    if lon > 79.0 + (13.5 - lat) * 0.2 and lat > 10.5:
        return False
    if lat > 13.0 and lon > 80.3:
        return False
    return True

def ghats_elevation_proxy(lat, lon):
    """Proxy for Western Ghats elevation: higher in western TN, peaks around Nilgiris/Kodaikanal."""
    # Western Ghats ridge roughly at lon 76.5-77.5 for lat 8-12
    # Nilgiris peak around (11.4, 76.7)
    # Kodaikanal around (10.23, 77.49)
    base = 0.0
    
    # Western Ghats general slope
    if lon < 77.8:
        base = max(0, (77.8 - lon) / 1.5) * 0.4
    
    # Nilgiris
    dist_nilg = math.sqrt((lat - 11.4)**2 + (lon - 76.7)**2)
    if dist_nilg < 0.8:
        base = max(base, (0.8 - dist_nilg) / 0.8 * 0.95)
    
    # Kodaikanal/Palani hills
    dist_koda = math.sqrt((lat - 10.23)**2 + (lon - 77.49)**2)
    if dist_koda < 0.5:
        base = max(base, (0.5 - dist_koda) / 0.5 * 0.75)
    
    # Javadi/Shevaroy hills
    dist_shev = math.sqrt((lat - 11.8)**2 + (lon - 78.2)**2)
    if dist_shev < 0.4:
        base = max(base, (0.4 - dist_shev) / 0.4 * 0.45)
    
    return min(1.0, base)

def coastal_flood_proxy(lat, lon):
    """Proxy for coastal flood risk: higher near Bay of Bengal coast."""
    # Distance from east coast (simplified)
    coast_lon = min(80.3, 79.0 + max(0, 13.5 - lat) * 0.15)
    dist_coast = abs(lon - coast_lon)
    if lon > coast_lon:
        return 0.0
    coastal = max(0, 1 - dist_coast / 1.0) * 0.7
    
    # Cauvery delta region (high flood risk)
    dist_delta = math.sqrt((lat - 10.8)**2 + (lon - 79.5)**2)
    if dist_delta < 0.8:
        coastal = max(coastal, (0.8 - dist_delta) / 0.8 * 0.85)
    
    # Chennai coastal zone
    dist_chennai = math.sqrt((lat - 13.0)**2 + (lon - 80.2)**2)
    if dist_chennai < 0.4:
        coastal = max(coastal, (0.4 - dist_chennai) / 0.4 * 0.7)
    
    # Low-lying areas in southern coast
    if lat < 9.5 and lon > 78.5:
        coastal = max(coastal, 0.4)
    
    return min(1.0, coastal)

# Generate arrays
flood = np.zeros((HEIGHT, WIDTH), dtype=np.float32)
landslide = np.zeros((HEIGHT, WIDTH), dtype=np.float32)
slope = np.zeros((HEIGHT, WIDTH), dtype=np.float32)
population = np.zeros((HEIGHT, WIDTH), dtype=np.float32)
mask = np.zeros((HEIGHT, WIDTH), dtype=bool)

np.random.seed(42)
# Add some noise texture
noise = np.random.rand(HEIGHT, WIDTH) * 0.08

print("Generating hazard data...")

for y in range(HEIGHT):
    if y % 100 == 0:
        print(f"  Row {y}/{HEIGHT}")
    for x in range(WIDTH):
        lon = BBOX[0] + (x + 0.5) / WIDTH * (BBOX[2] - BBOX[0])
        lat = BBOX[3] - (y + 0.5) / HEIGHT * (BBOX[3] - BBOX[1])
        
        if not in_tamil_nadu(lat, lon):
            continue
        
        mask[y, x] = True
        elev = ghats_elevation_proxy(lat, lon)
        coast = coastal_flood_proxy(lat, lon)
        
        # Flood hazard
        flood[y, x] = min(1.0, coast + noise[y, x] * 0.5 + max(0, 0.15 - elev * 0.3))
        
        # Landslide hazard (strongly correlated with slope/elevation)
        landslide[y, x] = min(1.0, elev * 0.8 + noise[y, x] * 0.3 * elev)
        
        # Slope
        slope[y, x] = min(1.0, elev * 0.9 + noise[y, x] * 0.2 * elev)
        
        # Population
        pop = 0.05 + noise[y, x] * 0.05
        for clat, clon, intensity, radius_km in CITIES:
            dist = math.sqrt((lat - clat)**2 + (lon - clon)**2) * 111
            if dist < radius_km:
                pop = max(pop, intensity * (1 - dist / radius_km))
        population[y, x] = min(1.0, pop)

# Normalize
def norm_array(arr, m):
    valid = arr[m]
    if len(valid) == 0:
        return arr, 0, 1
    p2 = np.percentile(valid, 2)
    p98 = np.percentile(valid, 98)
    if p98 <= p2:
        p98 = p2 + 1
    out = np.clip((arr - p2) / (p98 - p2), 0, 1)
    out[~m] = 0
    return out, float(p2), float(p98)

print("Normalizing...")
flood_n, fl_min, fl_max = norm_array(flood, mask)
landslide_n, ls_min, ls_max = norm_array(landslide, mask)
slope_n, sl_min, sl_max = norm_array(slope, mask)
pop_n, po_min, po_max = norm_array(population, mask)

# Write hazards.png
print("Writing hazards.png...")
out_dir = "data/tamil_nadu"
os.makedirs(out_dir, exist_ok=True)

hazards = np.zeros((HEIGHT, WIDTH, 4), dtype=np.uint8)
hazards[:, :, 0] = (flood_n * 255).astype(np.uint8)
hazards[:, :, 1] = (landslide_n * 255).astype(np.uint8)
hazards[:, :, 2] = (slope_n * 255).astype(np.uint8)
hazards[:, :, 3] = 255

img = Image.fromarray(hazards, "RGBA")
img.save(os.path.join(out_dir, "hazards.png"), optimize=True)
hz_size = os.path.getsize(os.path.join(out_dir, "hazards.png"))
print(f"  hazards.png: {WIDTH}x{HEIGHT}, {hz_size/1024/1024:.1f} MB")

# Write aux_layers.png
print("Writing aux_layers.png...")
aux = np.zeros((HEIGHT, WIDTH, 4), dtype=np.uint8)
aux[:, :, 0] = (pop_n * 255).astype(np.uint8)
aux[:, :, 1] = (mask.astype(np.uint8) * 255)
aux[:, :, 3] = 255

img = Image.fromarray(aux, "RGBA")
img.save(os.path.join(out_dir, "aux_layers.png"), optimize=True)
ax_size = os.path.getsize(os.path.join(out_dir, "aux_layers.png"))
print(f"  aux_layers.png: {WIDTH}x{HEIGHT}, {ax_size/1024/1024:.1f} MB")

# AHP weights
AHP_CRITERIA = ["flood", "landslide", "slope", "exposure"]
AHP_MATRIX = np.array([
    [1,    1,    2,    3],
    [1,    1,    2,    3],
    [1/2,  1/2,  1,    2],
    [1/3,  1/3,  1/2,  1],
])

eigenvalues, eigenvectors = np.linalg.eig(AHP_MATRIX)
max_idx = np.argmax(eigenvalues.real)
lambda_max = eigenvalues[max_idx].real
weights = eigenvectors[:, max_idx].real
weights = weights / weights.sum()
ci = (lambda_max - 4) / 3
cr = ci / 0.90
weight_dict = dict(zip(AHP_CRITERIA, weights.tolist()))

print(f"AHP weights: {weight_dict}")
print(f"CR: {cr:.4f}")

# Write meta.json
meta = {
    "region_id": "tamil_nadu",
    "region_name": "Tamil Nadu",
    "bbox": BBOX,
    "crs": "EPSG:4326",
    "pixel_size_m": 500,
    "raster_width": WIDTH,
    "raster_height": HEIGHT,
    "date_ranges": {
        "sentinel1": {"years": [2023, 2024, 2025], "seasons": [{"name": "southwest", "months": [6,7,8,9]}, {"name": "northeast", "months": [10,11,12]}]},
        "chirps": {"start": "2020-01-01", "end": "2025-09-30"},
        "modis_ndvi": {"start": "2023-01-01", "end": "2025-09-30"},
        "worldcover": "2021",
        "population": "2020"
    },
    "sources": {
        "srtm": "USGS/SRTMGL1_003",
        "jrc_surface_water": "JRC/GSW1_4/GlobalSurfaceWater",
        "sentinel1": "COPERNICUS/S1_GRD",
        "chirps_daily": "UCSB-CHG/CHIRPS/DAILY",
        "esa_worldcover": "ESA/WorldCover/v200",
        "modis_ndvi": "MODIS/061/MOD13A1",
        "ghsl_pop": "JRC/GHSL/P2023A/GHS_POP",
        "gaul_level1": "FAO/GAUL/2015/level1",
        "gaul_level2": "FAO/GAUL/2015/level2"
    },
    "normalization": {
        "method": "min-max with 2nd/98th percentile clipping",
        "flood": {"min": float(fl_min), "max": float(fl_max)},
        "landslide": {"min": float(ls_min), "max": float(ls_max)},
        "slope_deg": {"min": float(sl_min), "max": float(sl_max)},
        "population": {"min": float(po_min), "max": float(po_max)}
    },
    "hazards_png": {
        "R": "flood_hazard (normalized 0-255)",
        "G": "landslide_hazard (normalized 0-255)",
        "B": "slope_deg (normalized 0-255)",
        "A": "255 (constant, do not use)"
    },
    "aux_png": {
        "R": "population_exposure (normalized 0-255)",
        "G": "valid_land_mask (255=land, 0=sea/outside)",
        "B": "unused",
        "A": "255 (constant)"
    },
    "flood_factors": {
        "jrc_occurrence": 0.30,
        "sar_water_freq": 0.25,
        "chirps_heavy_rain": 0.20,
        "relative_elevation": 0.15,
        "built_water_fraction": 0.10
    },
    "landslide_factors": {
        "slope": 0.40,
        "chirps_heavy_rain": 0.25,
        "landcover_vulnerability": 0.20,
        "ndvi_inverse": 0.15
    },
    "ahp": {
        "criteria": AHP_CRITERIA,
        "matrix": AHP_MATRIX.tolist(),
        "weights": weight_dict,
        "lambda_max": float(lambda_max),
        "ci": float(ci),
        "cr": float(cr)
    },
    "risk_classes": {
        "very_low": [0.0, 0.2],
        "low": [0.2, 0.4],
        "moderate": [0.4, 0.6],
        "high": [0.6, 0.8],
        "very_high": [0.8, 1.0]
    },
    "build_time": datetime.now().isoformat(),
    "limitations": [
        "Spatial resolution: 500m",
        "OSM road/facility data may be incomplete in rural areas",
        "Shelters approximated from OSM emergency/community facilities",
        "Not an official hazard assessment – for research/hackathon use",
        "GAUL district boundaries may not match latest admin boundaries",
        "Sentinel-1 water detection uses simple VV threshold, not a calibrated model"
    ],
    "data_note": "Generated using geographic proxy models. Run pipeline/01_gee_hazards.py --region tamil_nadu with authenticated GEE for satellite-derived data."
}

with open(os.path.join(out_dir, "meta.json"), "w") as f:
    json.dump(meta, f, indent=2)

print(f"\nmeta.json written")
print(f"\nDone! Files in {out_dir}/")
