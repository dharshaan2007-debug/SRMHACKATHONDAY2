#!/usr/bin/env python3
"""
02_district_stats.py – Compute per-district zonal statistics from hazard rasters.

Usage:
    python 02_district_stats.py --region tamil_nadu

Outputs:
    data/<region>/districts.geojson
    Updates data/<region>/meta.json with district info
"""

import argparse
import json
import os
import sys
from pathlib import Path

import ee
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import (
    GEE_PROJECT, REGIONS, GEE_COLLECTIONS, AHP_MATRIX, AHP_CRITERIA, AHP_RI,
    RISK_CLASSES, DATA_DIR
)


def compute_ahp_weights(matrix):
    """Compute AHP weights."""
    n = matrix.shape[0]
    eigenvalues, eigenvectors = np.linalg.eig(matrix)
    max_idx = np.argmax(eigenvalues.real)
    weights = eigenvectors[:, max_idx].real
    weights = weights / weights.sum()
    return dict(zip(AHP_CRITERIA, weights.tolist()))


def classify_risk(value):
    """Classify a 0-1 risk value into a risk class."""
    for cls, (lo, hi) in RISK_CLASSES.items():
        if lo <= value < hi:
            return cls
    return "very_high"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", required=True)
    args = parser.parse_args()

    region_id = args.region
    region = REGIONS[region_id]
    out_dir = os.path.join(DATA_DIR, region_id)

    print(f"\n{'='*60}")
    print(f"District Statistics – {region['name']}")
    print(f"{'='*60}\n")

    # Initialize EE
    ee.Initialize(project=GEE_PROJECT)
    print("  EE initialized")

    # Get district boundaries from GAUL Level 2
    gaul2 = ee.FeatureCollection(GEE_COLLECTIONS["gaul_level2"])
    gaul1 = ee.FeatureCollection(GEE_COLLECTIONS["gaul_level1"])

    # Find the state
    state = gaul1.filter(ee.Filter.eq("ADM1_NAME", region["gaul_name"]))
    state_code = state.first().get("ADM1_CODE").getInfo()
    print(f"  State code: {state_code}")

    # Get districts within the state
    districts = gaul2.filter(ee.Filter.eq("ADM1_CODE", state_code))
    count = districts.size().getInfo()
    print(f"  Found {count} districts")

    # Load hazard rasters to get normalization info
    meta_path = os.path.join(out_dir, "meta.json")
    with open(meta_path) as f:
        meta = json.load(f)

    # Load the raster images
    hazards_img = Image.open(os.path.join(out_dir, "hazards.png"))
    aux_img = Image.open(os.path.join(out_dir, "aux_layers.png"))
    hazards_arr = np.array(hazards_img)
    aux_arr = np.array(aux_img)

    h, w = hazards_arr.shape[:2]
    bbox = meta["bbox"]
    west, south, east, north = bbox

    # AHP weights
    weights = compute_ahp_weights(AHP_MATRIX)
    print(f"  AHP weights: {weights}")

    # Get district features with geometry
    print("  Fetching district geometries from GEE...")
    district_list = districts.getInfo()

    features_out = []
    for i, feat in enumerate(district_list["features"]):
        props = feat["properties"]
        name = props.get("ADM2_NAME", f"District_{i}")
        print(f"  Processing district: {name}")

        # Get the district geometry
        geom = feat["geometry"]

        # Simplify geometry for output
        district_ee = ee.Feature(ee.Geometry(geom))
        simplified = district_ee.simplify(maxError=1000)  # 1km tolerance
        simple_geom = simplified.geometry().getInfo()

        # Compute bounding box of district in pixel coords
        coords = []
        if simple_geom["type"] == "Polygon":
            coords = simple_geom["coordinates"][0]
        elif simple_geom["type"] == "MultiPolygon":
            for poly in simple_geom["coordinates"]:
                coords.extend(poly[0])

        if not coords:
            continue

        lons = [c[0] for c in coords]
        lats = [c[1] for c in coords]
        d_west, d_east = min(lons), max(lons)
        d_south, d_north = min(lats), max(lats)

        # Convert to pixel coordinates
        px_west = int((d_west - west) / (east - west) * w)
        px_east = int((d_east - west) / (east - west) * w)
        px_north = int((1 - (d_north - south) / (north - south)) * h)
        px_south = int((1 - (d_south - south) / (north - south)) * h)

        # Clamp
        px_west = max(0, min(w - 1, px_west))
        px_east = max(0, min(w - 1, px_east))
        px_north = max(0, min(h - 1, px_north))
        px_south = max(0, min(h - 1, px_south))

        if px_east <= px_west or px_south <= px_north:
            continue

        # Extract region from rasters
        region_hazards = hazards_arr[px_north:px_south, px_west:px_east]
        region_aux = aux_arr[px_north:px_south, px_west:px_east]

        # Land mask
        land = region_aux[:, :, 1] > 127
        n_land = np.sum(land)
        if n_land < 10:
            continue

        # Extract normalized values (0-1)
        flood_vals = region_hazards[:, :, 0][land].astype(float) / 255.0
        landslide_vals = region_hazards[:, :, 1][land].astype(float) / 255.0
        slope_vals = region_hazards[:, :, 2][land].astype(float) / 255.0
        pop_vals = region_aux[:, :, 0][land].astype(float) / 255.0

        mean_flood = float(np.mean(flood_vals))
        mean_landslide = float(np.mean(landslide_vals))
        mean_slope = float(np.mean(slope_vals))
        mean_pop = float(np.mean(pop_vals))

        # Composite risk
        composite = (
            mean_flood * weights["flood"]
            + mean_landslide * weights["landslide"]
            + mean_slope * weights["slope"]
            + mean_pop * weights["exposure"]
        )
        risk_class = classify_risk(composite)

        out_feat = {
            "type": "Feature",
            "geometry": simple_geom,
            "properties": {
                "name": name,
                "adm2_code": props.get("ADM2_CODE"),
                "mean_flood": round(mean_flood, 4),
                "mean_landslide": round(mean_landslide, 4),
                "mean_slope": round(mean_slope, 4),
                "mean_exposure": round(mean_pop, 4),
                "composite_risk": round(composite, 4),
                "risk_class": risk_class,
                "pixel_count": int(n_land),
            }
        }
        features_out.append(out_feat)
        print(f"    {name}: risk={composite:.3f} ({risk_class})")

    # Sort by composite risk
    features_out.sort(key=lambda f: f["properties"]["composite_risk"], reverse=True)

    geojson = {
        "type": "FeatureCollection",
        "features": features_out
    }

    out_path = os.path.join(out_dir, "districts.geojson")
    with open(out_path, "w") as f:
        json.dump(geojson, f)

    size_mb = os.path.getsize(out_path) / 1024 / 1024
    print(f"\n  districts.geojson: {len(features_out)} districts, {size_mb:.2f} MB")

    # Check size limit
    if size_mb > 1.5:
        print("  WARNING: File exceeds 1.5 MB target – consider more simplification")

    # Update meta.json
    with open(meta_path) as f:
        meta = json.load(f)
    meta["districts"] = {
        "count": len(features_out),
        "boundary_source": "FAO GAUL 2015 Level 2",
        "simplification_m": 1000,
        "top5_risk": [
            {"name": f["properties"]["name"], "risk": f["properties"]["composite_risk"]}
            for f in features_out[:5]
        ]
    }
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print("  meta.json updated with district info")

    print(f"\n{'='*60}")
    print("DISTRICT STATS COMPLETE")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
