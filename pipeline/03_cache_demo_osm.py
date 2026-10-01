#!/usr/bin/env python3
"""
03_cache_demo_osm.py – Pre-fetch OSM data for demo cities via Overpass API.

Usage:
    python 03_cache_demo_osm.py

Outputs:
    data/demo_cache/<city>.json for each demo city
"""

import json
import os
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import DEMO_CITIES, DATA_DIR

OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

HIGHWAY_TYPES = "motorway|trunk|primary|secondary|tertiary|unclassified|residential"


def fetch_overpass(query, timeout=60):
    """Try Overpass mirrors in order."""
    for mirror in OVERPASS_MIRRORS:
        try:
            print(f"    Trying {mirror.split('/')[2]}...")
            resp = requests.post(
                mirror,
                data={"data": query},
                timeout=timeout,
                headers={"User-Agent": "GeoImpathon-HazardRouter/1.0"}
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            print(f"    Failed: {e}")
            time.sleep(2)
    raise RuntimeError("All Overpass mirrors failed")


def build_query(lat, lon, radius_m):
    """Build Overpass QL query for roads, hospitals, shelters, settlements."""
    return f"""
[out:json][timeout:90];
(
  // Roads
  way["highway"~"^({HIGHWAY_TYPES})$"](around:{radius_m},{lat},{lon});
  // Hospitals
  node["amenity"="hospital"](around:{radius_m},{lat},{lon});
  way["amenity"="hospital"](around:{radius_m},{lat},{lon});
  // Shelters / emergency facilities
  node["amenity"~"^(shelter|community_centre|public_building)$"](around:{radius_m},{lat},{lon});
  node["emergency"~"^(assembly_point|shelter)$"](around:{radius_m},{lat},{lon});
  way["amenity"~"^(shelter|community_centre|public_building)$"](around:{radius_m},{lat},{lon});
  // Settlements (place nodes)
  node["place"~"^(city|town|village|hamlet|suburb|neighbourhood)$"](around:{radius_m},{lat},{lon});
);
out body;
>;
out skel qt;
"""


def compact_osm(data):
    """Convert Overpass JSON to compact format for caching."""
    nodes = {}
    ways = []
    hospitals = []
    shelters = []
    settlements = []

    for elem in data.get("elements", []):
        if elem["type"] == "node":
            nid = elem["id"]
            nodes[nid] = [round(elem["lat"], 6), round(elem["lon"], 6)]

            tags = elem.get("tags", {})
            if tags.get("amenity") == "hospital":
                hospitals.append({
                    "id": nid,
                    "lat": round(elem["lat"], 6),
                    "lon": round(elem["lon"], 6),
                    "name": tags.get("name", "Hospital"),
                })
            elif tags.get("amenity") in ("shelter", "community_centre", "public_building") or \
                 tags.get("emergency") in ("assembly_point", "shelter"):
                shelters.append({
                    "id": nid,
                    "lat": round(elem["lat"], 6),
                    "lon": round(elem["lon"], 6),
                    "name": tags.get("name", "Shelter"),
                })
            elif tags.get("place"):
                settlements.append({
                    "id": nid,
                    "lat": round(elem["lat"], 6),
                    "lon": round(elem["lon"], 6),
                    "name": tags.get("name", tags.get("place", "Settlement")),
                    "type": tags.get("place"),
                })

        elif elem["type"] == "way":
            tags = elem.get("tags", {})
            if tags.get("highway"):
                way = {
                    "id": elem["id"],
                    "nodes": elem.get("nodes", []),
                    "highway": tags.get("highway"),
                    "name": tags.get("name", ""),
                    "oneway": tags.get("oneway", "no"),
                }
                ways.append(way)
            elif tags.get("amenity") == "hospital":
                # Way-based hospital – use centroid
                way_nodes = elem.get("nodes", [])
                lats = [nodes[n][0] for n in way_nodes if n in nodes]
                lons = [nodes[n][1] for n in way_nodes if n in nodes]
                if lats and lons:
                    hospitals.append({
                        "id": elem["id"],
                        "lat": round(sum(lats) / len(lats), 6),
                        "lon": round(sum(lons) / len(lons), 6),
                        "name": tags.get("name", "Hospital"),
                    })
            elif tags.get("amenity") in ("shelter", "community_centre", "public_building"):
                way_nodes = elem.get("nodes", [])
                lats = [nodes[n][0] for n in way_nodes if n in nodes]
                lons = [nodes[n][1] for n in way_nodes if n in nodes]
                if lats and lons:
                    shelters.append({
                        "id": elem["id"],
                        "lat": round(sum(lats) / len(lats), 6),
                        "lon": round(sum(lons) / len(lons), 6),
                        "name": tags.get("name", "Shelter"),
                    })

    # Convert node IDs in ways to coordinates for compact storage
    compact_ways = []
    for way in ways:
        coords = []
        for nid in way["nodes"]:
            if nid in nodes:
                coords.append(nodes[nid])
        if len(coords) >= 2:
            compact_ways.append({
                "id": way["id"],
                "coords": coords,
                "highway": way["highway"],
                "name": way["name"],
                "oneway": way["oneway"],
            })

    return {
        "ways": compact_ways,
        "hospitals": hospitals,
        "shelters": shelters,
        "settlements": settlements,
        "node_count": len(nodes),
        "way_count": len(compact_ways),
    }


def main():
    print(f"\n{'='*60}")
    print("Demo OSM Cache Builder")
    print(f"{'='*60}\n")

    out_dir = os.path.join(DATA_DIR, "demo_cache")
    os.makedirs(out_dir, exist_ok=True)

    for city_name, lat, lon, radius in DEMO_CITIES:
        print(f"\n  {city_name} ({lat}, {lon}, radius={radius}m)")
        try:
            query = build_query(lat, lon, radius)
            raw = fetch_overpass(query)
            compact = compact_osm(raw)
            compact["center"] = [lat, lon]
            compact["radius_m"] = radius
            compact["city"] = city_name

            out_path = os.path.join(out_dir, f"{city_name.lower()}.json")
            with open(out_path, "w") as f:
                json.dump(compact, f)

            size_kb = os.path.getsize(out_path) / 1024
            print(f"    Saved: {compact['way_count']} ways, "
                  f"{len(compact['hospitals'])} hospitals, "
                  f"{len(compact['shelters'])} shelters, "
                  f"{len(compact['settlements'])} settlements, "
                  f"{size_kb:.0f} KB")

            time.sleep(5)  # Be polite to Overpass
        except Exception as e:
            print(f"    ERROR: {e}")
            continue

    print(f"\n{'='*60}")
    print("DEMO CACHE COMPLETE")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
