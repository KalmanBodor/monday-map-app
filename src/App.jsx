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
  const markerCoords = useRef({});
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
	mapRef.current = new mapboxgl.Map({
	  container: mapContainer.current,
	  style: 'mapbox://styles/mapbox/streets-v11',
	  center: [-73.935242, 40.730610],
	  zoom: 10,
	});

	window.map = mapRef.current;
	window.mapboxgl = mapboxgl;

	return () => mapRef.current?.remove();
  }, []);

  useEffect(() => {
	monday.listen("context", async (res) => {
	  const boardId = res.data.boardId;
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
		const items = response?.data?.boards?.[0]?.items_page?.items || [];
		setItems(items);

		const map = mapRef.current;

		async function geocode(address) {
		  const resp = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${mapboxgl.accessToken}`);
		  const data = await resp.json();
		  return data.features[0]?.center;
		}

		async function plotPins() {
		  for (const item of items) {
			const address = item.column_values.find(col => col.column.title.match(/address/i))?.text;
			let status = item.column_values.find(col => col.id === "status")?.text || 'Prospective';
			if (!address) continue;

			const coords = await geocode(address);
			if (!coords) continue;

			markerCoords.current[item.id] = coords;

			new mapboxgl.Marker({ color: status === "Sold" ? "red" : "green" })
			  .setLngLat(coords)
			  .setPopup(
				new mapboxgl.Popup().setHTML(
				  `<div class="popup-${status.toLowerCase()}">${item.name} — ${status}</div>`
				)
			  )
			  .addTo(map);
		  }
		}

		if (map.loaded()) {
		  plotPins();
		} else {
		  map.on('load', plotPins);
		}

		setLoading(false);
	  } catch (err) {
		console.error("Error fetching board data:", err);
	  }
	});
  }, []);

  const flyToItem = (id) => {
	const coords = markerCoords.current[id];
	if (coords && mapRef.current) {
	  mapRef.current.flyTo({ center: coords, zoom: 15 });
	}
  };

  return (
	<div id="root">
	  {sidebarOpen ? (
		<div className="sidebar">
			<button className="list-toggle"
		  		onClick={() => setSidebarOpen(false)}>
				Hide Properties
			</button>
		  	
			<div className="cards-container">
				{items.map(item => {
					console.log(item);
					const address = item.column_values.find(col => col.column.title.match(/address/i))?.text || '(No address)';
					return (
						<div
							key={item.id}
							onClick={() => flyToItem(item.id)}
							className='card'>
							<div className="card-addr">{address}</div>
							<div>{item.name}</div>
							<ul className='item-cols'>
								{item.column_values.map(col => {
									return (
										<li>
											<div className='col-label'>{col.colum.title}</div>
											<div className='col-val'>{col.text}</div>
										</li>
									);
								})}
							</ul>
						</div>
					);
				})}
		  	</div>
		</div>
	  ) : (
		<button className="sidebar-toggle" onClick={() => setSidebarOpen(true)}>
		  Show Properties
		</button>
	  )}
	  <div ref={mapContainer} className="map-container" />
	  {loading && <div style={{ position: 'absolute', zIndex: 1, padding: 10 }}>Loading map data...</div>}
	</div>
  );
}

export default App;
