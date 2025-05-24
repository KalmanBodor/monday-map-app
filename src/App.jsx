import { useEffect, useRef, useState } from 'react';

import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

import './App.css';

import mondaySdk from "monday-sdk-js";

const monday = mondaySdk();
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

function App() {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Initialize map once
    mapRef.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v11',
      center: [-73.935242, 40.730610], // NYC
      zoom: 10,
    });

    window.map = mapRef.current;
    window.mapboxgl = mapboxgl;

    return () => mapRef.current?.remove();
  }, []);

  useEffect(() => {
    monday.listen("context", async (res) => {
      const boardId = res.data.boardId;
      console.log("Board ID:", boardId);

      if (!boardId) return;

      try {
        const query = `
          query {
            boards(ids: ${boardId}) {
              items_page {  
                items {
                  id
                  name
                  column_values {
                    id
                    value
                    text
                    column {
                      title
                    }
                  }
                }
              }
            }
          }
        `;

        const response = await monday.api(query);

        console.log("Full GraphQL response:", response);

        const boards = response?.data?.boards;
        if (!boards || boards.length === 0) {
          console.error("No boards returned.");
          return;
        }

        const items = response?.data?.boards?.[0]?.items_page?.items;
        if (!Array.isArray(items)) {
          console.error("No items received");
          return;
        }

        console.log("Fetched items:", items);

        const map = mapRef.current;

        mapRef.current.on('load', async () => {
          for (const item of items) {
            const address = item.column_values.find(col => col.column.title.match(/address/i))?.text;
            const status = item.column_values.find(col => col.id === "status")?.text;

            console.log("ADDR: " + address);

            if (!address) continue;

            const coords = await geocode(address);
            console.log("COORD: " + coords);
            if (!coords) continue;

            new mapboxgl.Marker({ color: status === "Sold" ? "red" : "green" })
              .setLngLat(coords)
              .setPopup(new mapboxgl.Popup().setText(`${item.name} — ${status}`))
              .addTo(map);
          }
        });

        setLoading(false);
      } catch (err) {
        console.error("Error fetching board data:", err);
      }
    });

    async function geocode(address) {
      const resp = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${mapboxgl.accessToken}`);
      const data = await resp.json();
      return data.features[0]?.center;
    }
  }, []);

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      {loading && <div style={{ position: 'absolute', zIndex: 1, padding: 10 }}>Loading map data...</div>}
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

export default App;
