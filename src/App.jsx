import './polyfills'; // Import polyfills first
import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import mondaySdk from "monday-sdk-js";
import Modal from 'react-modal';
import {
	Button,
	Dropdown,
	Checkbox,
	Text,
	Icon,
	IconButton,
	Tooltip,
	Avatar,
	Flex,
	Box
} from '@vibe/core';
import { PDF, Country, Location, Remove, Check } from '@vibe/icons';
import '@vibe/core/tokens';
import './App.css';
import photoPlaceholder from './assets/city_skyline.svg';

const monday = mondaySdk();
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

function App() {
	const mapContainer = useRef(null);
	const mapRef = useRef(null);
	const markerCoords = useRef({});
	const [items, setItems] = useState([]);
	const [selectedItemId, setSelectedItemId] = useState(null);
	const [hoveredItem, setHoveredItem] = useState(null);
	const [galleryImages, setGalleryImages] = useState([]);
	const [currentIndex, setCurrentIndex] = useState(0);
	
	// New state for board selection and route planning
	const [boards, setBoards] = useState([]);
	const [currentBoardId, setCurrentBoardId] = useState(null);
	const [selectedItems, setSelectedItems] = useState(new Set());
	const [showSelectionModal, setShowSelectionModal] = useState(false);

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

	Modal.setAppElement('#root');

	// Enhanced geocoding function with context data
	async function geocode(address) {
		const resp = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${mapboxgl.accessToken}`);
		const data = await resp.json();
		console.log(data);
		
		if (data.features && data.features[0]) {
			const feature = data.features[0];
			const context = feature.context || [];
			
			// Extract neighborhood and locality
			const neighborhood = context.find(ctx => ctx.id.startsWith('neighborhood.'));
			const locality = context.find(ctx => ctx.id.startsWith('locality.'));
			
			let nhoodCity = '';
			if (neighborhood && locality) {
				nhoodCity = `${neighborhood.text}, ${locality.text}`;
			} else if (locality) {
				nhoodCity = locality.text;
			} else if (neighborhood) {
				nhoodCity = neighborhood.text;
			}
			
			return {
				center: feature.center,
				matching_place_name: feature.place_name,
				nhoodCity: nhoodCity
			};
		}
		
		return null;
	}

	// Fetch all boards
	const fetchBoards = async () => {
		try {
			const query = `
				query {
					boards {
						id
						name
					}
				}
			`;
			const response = await monday.api(query);
			console.log("Boards response:", response);
			const boardsData = response?.data?.boards || [];
			setBoards(boardsData);
			console.log("Boards set:", boardsData);
		} catch (err) {
			console.error("Error fetching boards:", err);
		}
	};

	const processItems = (apiResponse) => {
		let allItems = [];
		apiResponse?.data?.boards?.forEach(board => {
			const boardItems = board?.items_page?.items || [];
			allItems = [...allItems, ...boardItems];
		});

		allItems = allItems.map(item => {
			const addrCol = item.column_values.find(col => col.column.title.match(/address/i));
			const status = item.column_values.find(col => col.column.title.match(/status/i));
			let statusStyle = null;

			if (status?.value && status.column?.settings_str) {
				try {
					const meta = JSON.parse(status.column.settings_str);
					const val = JSON.parse(status.value);
					statusStyle = { color : meta.labels_colors[val.index]?.color || 'orange', fontWeight: 600 };
					status.statusStyle = statusStyle;
					item.statusStyle = statusStyle;
				} catch (e) {}
			}

			const imageUrls = [];
			item.column_values.forEach(col => {
				if (col.id.startsWith("file_")) {
					col.skipDisplayFile = true;
					if (col.value && col.text) {
						try {
							const fileObj = JSON.parse(col.value);
							const files = fileObj.files || [];
							files.forEach(f => {
								if (f.isImage === "true") {
									let listSplit = col.text.split(/,\s*/) || [];
									let urlBase = listSplit[0].match(/https:\/\/.*.monday.com\/protected_static\/\d+\/resources\//);
									urlBase = urlBase[0];

									if (urlBase) imageUrls.push(`${urlBase}/${f.assetId}/${f.name}`);
								}
							});
						} catch (e) {
							console.warn("Error parsing file column:", e);
						}
					}
				} else {
					col.skipDisplayFile = false;
				}
			});
			item.images = imageUrls;
			item.thumb = imageUrls[0] || null;

			return {
				...item,
				address: addrCol?.text || '',
				addressColumnTitle: addrCol?.column?.title || 'Address',
				originalAddress: addrCol?.text || '',
				parsedAddress: '',
				nhoodCity: ''
			};
		});

		return allItems;
	};

	const fetchItemsFromBoard = async (boardSelections) => {
		try {
			let boardIds = [];
			
			if (boardSelections.some( brd => brd.value == 'all' )) {
				boardIds.push(...boards.map(b => parseInt(b.id)));
			}

			if (boardSelections.some( brd => brd.value == 'current')) {
				boardIds.push(currentBoardId);
			}
				
			if (boardSelections.length) {
				boardIds.push(...boards.map(b => parseInt(b.id)));
			}

			if (boardIds.length === 0) return;

			const boardIdsString = boardIds.join(',');

			const query = `
				query {
					boards(ids: [${boardIdsString}]) {
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
										settings_str
									}
								}
							}
						}
					}
				}
			`;

			const response = await monday.api(query);
			console.log('API Response:', response);
			
			let allItems = processItems(response);
			setItems(allItems);
			await plotPins(allItems);
		} catch (err) {
			console.error("Error fetching board data:", err);
		}
	};

	// Plot pins with enhanced geocoding
	async function plotPins(itemsToPlot) {
		const map = mapRef.current;
		
		// Clear existing markers
		const existingMarkers = document.querySelectorAll('.mapboxgl-marker');
		existingMarkers.forEach(marker => marker.remove());
		markerCoords.current = {};

		for (const item of itemsToPlot) {
			if (!item.address) continue;

			const geocodeResult = await geocode(item.address);
			if (!geocodeResult) continue;

			const coords = geocodeResult.center;
			markerCoords.current[item.id] = coords;
			
			// Update item with geocoded data
			item.coords = [coords[1], coords[0]].join(',');
			item.parsedAddress = geocodeResult.matching_place_name.replace(/(, )?United States/, '');
			item.nhoodCity = geocodeResult.nhoodCity;
			item.driveLink = isIOS()
				? `http://maps.apple.com/?daddr=${item.coords}`
				: `https://www.google.com/maps/dir/?api=1&destination=${item.coords}`;

			let marker = new mapboxgl.Marker({
				color: item.statusStyle?.color || "#orange"
			})
			.setLngLat(coords)
			.addTo(map);

			marker.getElement().addEventListener('mouseenter', () => {
				setHoveredItem({
					id: item.id,
					name: item.name,
					address: item.parsedAddress,
					coords: marker.getLngLat()
				});
			});

			marker.getElement().addEventListener('mouseleave', () => {
				setHoveredItem(null);
			});
		}
		
		// Update items state with geocoded data
		setItems(prevItems => {
			return prevItems.map(prevItem => {
				const updatedItem = itemsToPlot.find(item => item.id === prevItem.id);
				return updatedItem || prevItem;
			});
		});
	}

	// Handle board selection change
	const handleBoardChange = (options) => {
		const values = options.map( option => { return option.value });
		console.log()
		setSelectedItems(new Set()); // Clear selections when changing boards
		setLoading(true);
		fetchItemsFromBoard(values).finally(() => setLoading(false));
	};

	// Handle item selection
	const handleItemSelection = (itemId, checked) => {
		const newSelection = new Set(selectedItems);
		if (checked) {
			newSelection.add(itemId);
		} else {
			newSelection.delete(itemId);
		}
		setSelectedItems(newSelection);
	};

	// Handle route planning
	const handleRoutePlanning = () => {
		if (selectedItems.size === 0) {
			setShowSelectionModal(true);
			return;
		}

		const selectedItemsArray = Array.from(selectedItems);
		const coordinates = selectedItemsArray
			.map(id => items.find(item => item.id === id))
			.filter(item => item && item.coords)
			.map(item => item.coords);

		if (coordinates.length === 0) return;

		// Create route URL
		const isIOSDevice = isIOS();
		let routeUrl;

		if (coordinates.length === 1) {
			// Single destination
			routeUrl = isIOSDevice
				? `http://maps.apple.com/?daddr=${coordinates[0]}`
				: `https://www.google.com/maps/dir/?api=1&destination=${coordinates[0]}`;
		} else {
			// Multiple destinations
			if (isIOSDevice) {
				// Apple Maps doesn't support multiple waypoints via URL, so use first destination
				routeUrl = `http://maps.apple.com/?daddr=${coordinates[0]}`;
			} else {
				// Google Maps with waypoints
				const destination = coordinates[coordinates.length - 1];
				const waypoints = coordinates.slice(0, -1).join('|');
				routeUrl = `https://www.google.com/maps/dir/?api=1&destination=${destination}&waypoints=${waypoints}`;
			}
		}

		window.open(routeUrl, '_blank');
	};

	// Handle PDF generation
	const handlePDFGeneration = () => {
		if (selectedItems.size === 0) {
			setShowSelectionModal(true);
			return;
		}

		// Create a printable version of selected items
		const selectedItemsData = Array.from(selectedItems)
			.map(id => items.find(item => item.id === id))
			.filter(Boolean);

		// Create a new window with printable content
		const printWindow = window.open('', '_blank');
		const printContent = `
			<!DOCTYPE html>
			<html>
			<head>
				<title>Selected Properties Report</title>
				<style>
					body { font-family: Arial, sans-serif; margin: 20px; }
					.property { margin-bottom: 30px; border-bottom: 1px solid #ccc; padding-bottom: 20px; }
					.property-name { font-size: 18px; font-weight: bold; margin-bottom: 5px; }
					.property-address { color: #666; margin-bottom: 10px; }
					.property-details { list-style: none; padding: 0; }
					.property-details li { margin: 5px 0; }
				</style>
			</head>
			<body>
				<h1>Selected Properties Report</h1>
				<p>Generated on: ${new Date().toLocaleDateString()}</p>
				${selectedItemsData.map(item => `
					<div class="property">
						<div class="property-name">${item.name}</div>
						<div class="property-address">${item.parsedAddress}</div>
						${item.nhoodCity ? `<div class="property-address">${item.nhoodCity}</div>` : ''}
						<ul class="property-details">
							${item.column_values.filter(col => !col.skipDisplayFile).map(col => `
								<li><strong>${col.column.title}:</strong> ${autoFormat(col.text)}</li>
							`).join('')}
						</ul>
					</div>
				`).join('')}
			</body>
			</html>
		`;
		
		printWindow.document.write(printContent);
		printWindow.document.close();
		printWindow.focus();
		printWindow.print();
	};

	function autoFormat(value) {
		if (/\d{4}-\d{2}-\d{2}/.test(value)) {
			const date = new Date(value);
			if (isNaN(date)) return value;
			return new Intl.DateTimeFormat('en-US').format(date);
		} else if (/^\d+$/.test(value)) {
			const formatter = new Intl.NumberFormat('en-US', {
				minimumFractionDigits: 0,
				maximumFractionDigits: 2
			});
			return formatter.format(value);
		}

		return value;
	}

	function isIOS() {
		return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
	}

	useEffect(() => {
		if (import.meta.env.DEV) {
			console.log("Using mock data...");
			let mockItems = {
    "data": {
        "boards": [
            {
                "items_page": {
                    "items": [
                        {
                            "id": "1973520784",
                            "name": "mehh",
                            "column_values": [
                                {
                                    "id": "person",
                                    "value": "{\"changed_at\":\"2025-05-24T14:00:03.379Z\",\"personsAndTeams\":[{\"id\":76184316,\"kind\":\"person\"}]}",
                                    "text": "BK",
                                    "column": {
                                        "title": "Person",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "status",
                                    "value": "{\"index\":1,\"post_id\":null,\"changed_at\":\"2025-05-24T14:07:26.376Z\"}",
                                    "text": "Done",
                                    "column": {
                                        "title": "Status",
                                        "settings_str": "{\"done_colors\":[1],\"labels\":{\"0\":\"Working on it\",\"1\":\"Done\",\"2\":\"Stuck\"},\"labels_positions_v2\":{\"0\":0,\"1\":2,\"2\":1,\"5\":3},\"labels_colors\":{\"0\":{\"color\":\"#fdab3d\",\"border\":\"#e99729\",\"var_name\":\"orange\"},\"1\":{\"color\":\"#00c875\",\"border\":\"#00b461\",\"var_name\":\"green-shadow\"},\"2\":{\"color\":\"#df2f4a\",\"border\":\"#ce3048\",\"var_name\":\"red-shadow\"}}}"
                                    },
                                    "statusStyle": {
                                        "color": "#00c875",
                                        "fontWeight": 600
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "date4",
                                    "value": "{\"date\":\"2025-05-30\",\"changed_at\":\"2025-05-24T14:00:06.721Z\"}",
                                    "text": "2025-05-30",
                                    "column": {
                                        "title": "Date",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "text_mkr856vm",
                                    "value": "\"57 lenox ave, nyc\"",
                                    "text": "57 lenox ave, nyc",
                                    "column": {
                                        "title": "Address",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "numeric_mkrq3y6w",
                                    "value": "\"1231\"",
                                    "text": "1231",
                                    "column": {
                                        "title": "Sqft",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "file_mkrqk4z6",
                                    "value": "{\"files\":[{\"name\":\"494732606_1235284537982385_8014704447019579354_n.jpg\",\"assetId\":125951865,\"isImage\":\"true\",\"fileType\":\"ASSET\",\"createdAt\":1749369004275,\"createdBy\":\"76184316\"},{\"name\":\"495189454_1235284337982405_5546735201437970672_n.jpg\",\"assetId\":125951994,\"isImage\":\"true\",\"fileType\":\"ASSET\",\"createdAt\":1749369140336,\"createdBy\":\"76184316\"}]}",
                                    "text": "https://test607479.monday.com/protected_static/29580945/resources/125951865/494732606_1235284537982385_8014704447019579354_n.jpg, https://test607479.monday.com/protected_static/29580945/resources/125951994/495189454_1235284337982405_5546735201437970672_n.jpg",
                                    "column": {
                                        "title": "Picture",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": true
                                },
                                {
                                    "id": "file_mkrq8zv3",
                                    "value": "{\"files\":[{\"name\":\"496026058_1235284677982371_855974643083189448_n.jpg\",\"assetId\":125952183,\"isImage\":\"true\",\"fileType\":\"ASSET\",\"createdAt\":1749369367705,\"createdBy\":\"76184316\"}]}",
                                    "text": "https://test607479.monday.com/protected_static/29580945/resources/125952183/496026058_1235284677982371_855974643083189448_n.jpg",
                                    "column": {
                                        "title": "Files",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": true
                                }
                            ],
                            "statusStyle": {
                                "color": "#00c875",
                                "fontWeight": 600
                            },
                            "images": [
                                "https://test607479.monday.com/protected_static/29580945/resources//125951865/494732606_1235284537982385_8014704447019579354_n.jpg",
                                "https://test607479.monday.com/protected_static/29580945/resources//125951994/495189454_1235284337982405_5546735201437970672_n.jpg",
                                "https://test607479.monday.com/protected_static/29580945/resources//125952183/496026058_1235284677982371_855974643083189448_n.jpg"
                            ],
                            "thumb": "https://test607479.monday.com/protected_static/29580945/resources//125951865/494732606_1235284537982385_8014704447019579354_n.jpg"
                        },
                        {
                            "id": "1983170907",
                            "name": "pff",
                            "column_values": [
                                {
                                    "id": "person",
                                    "value": null,
                                    "text": "",
                                    "column": {
                                        "title": "Person",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "status",
                                    "value": "{\"index\":0,\"post_id\":null,\"changed_at\":\"2025-06-01T11:44:56.066Z\"}",
                                    "text": "Working on it",
                                    "column": {
                                        "title": "Status",
                                        "settings_str": "{\"done_colors\":[1],\"labels\":{\"0\":\"Working on it\",\"1\":\"Done\",\"2\":\"Stuck\"},\"labels_positions_v2\":{\"0\":0,\"1\":2,\"2\":1,\"5\":3},\"labels_colors\":{\"0\":{\"color\":\"#fdab3d\",\"border\":\"#e99729\",\"var_name\":\"orange\"},\"1\":{\"color\":\"#00c875\",\"border\":\"#00b461\",\"var_name\":\"green-shadow\"},\"2\":{\"color\":\"#df2f4a\",\"border\":\"#ce3048\",\"var_name\":\"red-shadow\"}}}"
                                    },
                                    "statusStyle": {
                                        "color": "#fdab3d",
                                        "fontWeight": 600
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "date4",
                                    "value": "{\"date\":\"2025-05-27\",\"changed_at\":\"2025-06-07T14:22:05.515Z\"}",
                                    "text": "2025-05-27",
                                    "column": {
                                        "title": "Date",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "text_mkr856vm",
                                    "value": "\"1 water st, nyc\"",
                                    "text": "1 water st, nyc",
                                    "column": {
                                        "title": "Address",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "numeric_mkrq3y6w",
                                    "value": "\"21231\"",
                                    "text": "21231",
                                    "column": {
                                        "title": "Sqft",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "file_mkrqk4z6",
                                    "value": null,
                                    "text": "",
                                    "column": {
                                        "title": "Picture",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": true
                                },
                                {
                                    "id": "file_mkrq8zv3",
                                    "value": null,
                                    "text": "",
                                    "column": {
                                        "title": "Files",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": true
                                }
                            ],
                            "statusStyle": {
                                "color": "#fdab3d",
                                "fontWeight": 600
                            },
                            "images": [],
                            "thumb": null
                        },
                        {
                            "id": "1973337079",
                            "name": "New Item",
                            "column_values": [
                                {
                                    "id": "person",
                                    "value": "{\"changed_at\":\"2025-05-24T12:48:28.973Z\",\"personsAndTeams\":[{\"id\":76184316,\"kind\":\"person\"}]}",
                                    "text": "BK",
                                    "column": {
                                        "title": "Person",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "status",
                                    "value": "{\"index\":2,\"post_id\":null,\"changed_at\":\"2025-06-07T08:10:26.633Z\"}",
                                    "text": "Stuck",
                                    "column": {
                                        "title": "Status",
                                        "settings_str": "{\"done_colors\":[1],\"labels\":{\"0\":\"Working on it\",\"1\":\"Done\",\"2\":\"Stuck\"},\"labels_positions_v2\":{\"0\":0,\"1\":2,\"2\":1,\"5\":3},\"labels_colors\":{\"0\":{\"color\":\"#fdab3d\",\"border\":\"#e99729\",\"var_name\":\"orange\"},\"1\":{\"color\":\"#00c875\",\"border\":\"#00b461\",\"var_name\":\"green-shadow\"},\"2\":{\"color\":\"#df2f4a\",\"border\":\"#ce3048\",\"var_name\":\"red-shadow\"}}}"
                                    },
                                    "statusStyle": {
                                        "color": "#df2f4a",
                                        "fontWeight": 600
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "date4",
                                    "value": "{\"date\":\"2025-05-07\",\"changed_at\":\"2025-05-31T09:58:40.019Z\"}",
                                    "text": "2025-05-07",
                                    "column": {
                                        "title": "Date",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "text_mkr856vm",
                                    "value": "\"104 w 113 st, NYC\"",
                                    "text": "104 w 113 st, NYC",
                                    "column": {
                                        "title": "Address",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "numeric_mkrq3y6w",
                                    "value": "\"4534\"",
                                    "text": "4534",
                                    "column": {
                                        "title": "Sqft",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "file_mkrqk4z6",
                                    "value": null,
                                    "text": "",
                                    "column": {
                                        "title": "Picture",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": true
                                },
                                {
                                    "id": "file_mkrq8zv3",
                                    "value": null,
                                    "text": "",
                                    "column": {
                                        "title": "Files",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": true
                                }
                            ],
                            "statusStyle": {
                                "color": "#df2f4a",
                                "fontWeight": 600
                            },
                            "images": [],
                            "thumb": null
                        },
                        {
                            "id": "1993979381",
                            "name": "New Item",
                            "column_values": [
                                {
                                    "id": "person",
                                    "value": "{\"personsAndTeams\":[{\"id\":76184316,\"kind\":\"person\"}]}",
                                    "text": "BK",
                                    "column": {
                                        "title": "Person",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "status",
                                    "value": "{\"index\":1,\"post_id\":null,\"changed_at\":\"2025-06-08T07:12:40.982Z\"}",
                                    "text": "Done",
                                    "column": {
                                        "title": "Status",
                                        "settings_str": "{\"done_colors\":[1],\"labels\":{\"0\":\"Working on it\",\"1\":\"Done\",\"2\":\"Stuck\"},\"labels_positions_v2\":{\"0\":0,\"1\":2,\"2\":1,\"5\":3},\"labels_colors\":{\"0\":{\"color\":\"#fdab3d\",\"border\":\"#e99729\",\"var_name\":\"orange\"},\"1\":{\"color\":\"#00c875\",\"border\":\"#00b461\",\"var_name\":\"green-shadow\"},\"2\":{\"color\":\"#df2f4a\",\"border\":\"#ce3048\",\"var_name\":\"red-shadow\"}}}"
                                    },
                                    "statusStyle": {
                                        "color": "#00c875",
                                        "fontWeight": 600
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "date4",
                                    "value": "{\"date\":\"2025-06-04\",\"changed_at\":\"2025-06-08T07:12:45.423Z\"}",
                                    "text": "2025-06-04",
                                    "column": {
                                        "title": "Date",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "text_mkr856vm",
                                    "value": "\"1 Madison Ave, New York, NY 10010\"",
                                    "text": "1 Madison Ave, New York, NY 10010",
                                    "column": {
                                        "title": "Address",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "numeric_mkrq3y6w",
                                    "value": "\"21000\"",
                                    "text": "21000",
                                    "column": {
                                        "title": "Sqft",
                                        "settings_str": "{}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "file_mkrqk4z6",
                                    "value": null,
                                    "text": "",
                                    "column": {
                                        "title": "Picture",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": true
                                },
                                {
                                    "id": "file_mkrq8zv3",
                                    "value": null,
                                    "text": "",
                                    "column": {
                                        "title": "Files",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": true
                                }
                            ],
                            "statusStyle": {
                                "color": "#00c875",
                                "fontWeight": 600
                            },
                            "images": [],
                            "thumb": null
                        }
                    ]
                }
            },
            {
                "items_page": {
                    "items": [
                        {
                            "id": "1962654007",
                            "name": "Task 1",
                            "column_values": [
                                {
                                    "id": "project_owner",
                                    "value": "{\"changed_at\":\"2023-08-23T12:42:09.066Z\",\"personsAndTeams\":[{\"id\":76184316,\"kind\":\"person\"}]}",
                                    "text": "BK",
                                    "column": {
                                        "title": "Owner",
                                        "settings_str": "{\"max_people_allowed\":\"0\"}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "project_status",
                                    "value": "{\"index\":0,\"post_id\":null,\"changed_at\":\"2023-03-06T14:43:16.460Z\"}",
                                    "text": "Working on it",
                                    "column": {
                                        "title": "Status",
                                        "settings_str": "{\"done_colors\":[1],\"color_mapping\":{\"8\":11,\"11\":8},\"labels\":{\"0\":\"Working on it\",\"1\":\"Done\",\"2\":\"Stuck\",\"5\":\"Not Started\"},\"labels_positions_v2\":{\"0\":1,\"1\":0,\"2\":2,\"5\":3},\"labels_colors\":{\"0\":{\"color\":\"#fdab3d\",\"border\":\"#e99729\",\"var_name\":\"orange\"},\"1\":{\"color\":\"#00c875\",\"border\":\"#00b461\",\"var_name\":\"green-shadow\"},\"2\":{\"color\":\"#df2f4a\",\"border\":\"#ce3048\",\"var_name\":\"red-shadow\"},\"5\":{\"color\":\"#c4c4c4\",\"border\":\"#b0b0b0\",\"var_name\":\"grey\"}}}"
                                    },
                                    "statusStyle": {
                                        "color": "#fdab3d",
                                        "fontWeight": 600
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "date",
                                    "value": "{\"date\":\"2025-05-17\",\"changed_at\":\"2023-11-08T17:42:20.136Z\"}",
                                    "text": "2025-05-17",
                                    "column": {
                                        "title": "Due date",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": false
                                }
                            ],
                            "statusStyle": {
                                "color": "#fdab3d",
                                "fontWeight": 600
                            },
                            "images": [],
                            "thumb": null
                        },
                        {
                            "id": "1962654011",
                            "name": "Task 2",
                            "column_values": [
                                {
                                    "id": "project_owner",
                                    "value": null,
                                    "text": "",
                                    "column": {
                                        "title": "Owner",
                                        "settings_str": "{\"max_people_allowed\":\"0\"}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "project_status",
                                    "value": "{\"index\":2,\"post_id\":null,\"changed_at\":\"2023-04-27T16:17:50.181Z\"}",
                                    "text": "Stuck",
                                    "column": {
                                        "title": "Status",
                                        "settings_str": "{\"done_colors\":[1],\"color_mapping\":{\"8\":11,\"11\":8},\"labels\":{\"0\":\"Working on it\",\"1\":\"Done\",\"2\":\"Stuck\",\"5\":\"Not Started\"},\"labels_positions_v2\":{\"0\":1,\"1\":0,\"2\":2,\"5\":3},\"labels_colors\":{\"0\":{\"color\":\"#fdab3d\",\"border\":\"#e99729\",\"var_name\":\"orange\"},\"1\":{\"color\":\"#00c875\",\"border\":\"#00b461\",\"var_name\":\"green-shadow\"},\"2\":{\"color\":\"#df2f4a\",\"border\":\"#ce3048\",\"var_name\":\"red-shadow\"},\"5\":{\"color\":\"#c4c4c4\",\"border\":\"#b0b0b0\",\"var_name\":\"grey\"}}}"
                                    },
                                    "statusStyle": {
                                        "color": "#df2f4a",
                                        "fontWeight": 600
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "date",
                                    "value": "{\"date\":\"2025-05-19\",\"changed_at\":\"2023-11-08T17:43:01.765Z\"}",
                                    "text": "2025-05-19",
                                    "column": {
                                        "title": "Due date",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": false
                                }
                            ],
                            "statusStyle": {
                                "color": "#df2f4a",
                                "fontWeight": 600
                            },
                            "images": [],
                            "thumb": null
                        },
                        {
                            "id": "1962654010",
                            "name": "Task 3",
                            "column_values": [
                                {
                                    "id": "project_owner",
                                    "value": null,
                                    "text": "",
                                    "column": {
                                        "title": "Owner",
                                        "settings_str": "{\"max_people_allowed\":\"0\"}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "project_status",
                                    "value": "{\"index\":1,\"post_id\":null,\"changed_at\":\"2023-04-27T16:16:13.187Z\"}",
                                    "text": "Done",
                                    "column": {
                                        "title": "Status",
                                        "settings_str": "{\"done_colors\":[1],\"color_mapping\":{\"8\":11,\"11\":8},\"labels\":{\"0\":\"Working on it\",\"1\":\"Done\",\"2\":\"Stuck\",\"5\":\"Not Started\"},\"labels_positions_v2\":{\"0\":1,\"1\":0,\"2\":2,\"5\":3},\"labels_colors\":{\"0\":{\"color\":\"#fdab3d\",\"border\":\"#e99729\",\"var_name\":\"orange\"},\"1\":{\"color\":\"#00c875\",\"border\":\"#00b461\",\"var_name\":\"green-shadow\"},\"2\":{\"color\":\"#df2f4a\",\"border\":\"#ce3048\",\"var_name\":\"red-shadow\"},\"5\":{\"color\":\"#c4c4c4\",\"border\":\"#b0b0b0\",\"var_name\":\"grey\"}}}"
                                    },
                                    "statusStyle": {
                                        "color": "#00c875",
                                        "fontWeight": 600
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "date",
                                    "value": "{\"date\":\"2025-05-18\",\"changed_at\":\"2023-11-08T17:42:23.641Z\"}",
                                    "text": "2025-05-18",
                                    "column": {
                                        "title": "Due date",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": false
                                }
                            ],
                            "statusStyle": {
                                "color": "#00c875",
                                "fontWeight": 600
                            },
                            "images": [],
                            "thumb": null
                        }
                    ]
                }
            },
            {
                "items_page": {
                    "items": [
                        {
                            "id": "1962649125",
                            "name": "Task 1",
                            "column_values": [
                                {
                                    "id": "project_owner",
                                    "value": "{\"changed_at\":\"2023-08-23T12:42:09.066Z\",\"personsAndTeams\":[{\"id\":76184316,\"kind\":\"person\"}]}",
                                    "text": "BK",
                                    "column": {
                                        "title": "Owner",
                                        "settings_str": "{\"max_people_allowed\":\"0\"}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "project_status",
                                    "value": "{\"index\":0,\"post_id\":null,\"changed_at\":\"2023-03-06T14:43:16.460Z\"}",
                                    "text": "Working on it",
                                    "column": {
                                        "title": "Status",
                                        "settings_str": "{\"done_colors\":[1],\"color_mapping\":{\"8\":11,\"11\":8},\"labels\":{\"0\":\"Working on it\",\"1\":\"Done\",\"2\":\"Stuck\",\"5\":\"Not Started\"},\"labels_positions_v2\":{\"0\":1,\"1\":0,\"2\":2,\"5\":3},\"labels_colors\":{\"0\":{\"color\":\"#fdab3d\",\"border\":\"#e99729\",\"var_name\":\"orange\"},\"1\":{\"color\":\"#00c875\",\"border\":\"#00b461\",\"var_name\":\"green-shadow\"},\"2\":{\"color\":\"#df2f4a\",\"border\":\"#ce3048\",\"var_name\":\"red-shadow\"},\"5\":{\"color\":\"#c4c4c4\",\"border\":\"#b0b0b0\",\"var_name\":\"grey\"}}}"
                                    },
                                    "statusStyle": {
                                        "color": "#fdab3d",
                                        "fontWeight": 600
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "date",
                                    "value": "{\"date\":\"2025-05-17\",\"changed_at\":\"2023-11-08T17:42:20.136Z\"}",
                                    "text": "2025-05-17",
                                    "column": {
                                        "title": "Due date",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": false
                                }
                            ],
                            "statusStyle": {
                                "color": "#fdab3d",
                                "fontWeight": 600
                            },
                            "images": [],
                            "thumb": null
                        },
                        {
                            "id": "1962649129",
                            "name": "Task 2",
                            "column_values": [
                                {
                                    "id": "project_owner",
                                    "value": null,
                                    "text": "",
                                    "column": {
                                        "title": "Owner",
                                        "settings_str": "{\"max_people_allowed\":\"0\"}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "project_status",
                                    "value": "{\"index\":2,\"post_id\":null,\"changed_at\":\"2023-04-27T16:17:50.181Z\"}",
                                    "text": "Stuck",
                                    "column": {
                                        "title": "Status",
                                        "settings_str": "{\"done_colors\":[1],\"color_mapping\":{\"8\":11,\"11\":8},\"labels\":{\"0\":\"Working on it\",\"1\":\"Done\",\"2\":\"Stuck\",\"5\":\"Not Started\"},\"labels_positions_v2\":{\"0\":1,\"1\":0,\"2\":2,\"5\":3},\"labels_colors\":{\"0\":{\"color\":\"#fdab3d\",\"border\":\"#e99729\",\"var_name\":\"orange\"},\"1\":{\"color\":\"#00c875\",\"border\":\"#00b461\",\"var_name\":\"green-shadow\"},\"2\":{\"color\":\"#df2f4a\",\"border\":\"#ce3048\",\"var_name\":\"red-shadow\"},\"5\":{\"color\":\"#c4c4c4\",\"border\":\"#b0b0b0\",\"var_name\":\"grey\"}}}"
                                    },
                                    "statusStyle": {
                                        "color": "#df2f4a",
                                        "fontWeight": 600
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "date",
                                    "value": "{\"date\":\"2025-05-19\",\"changed_at\":\"2023-11-08T17:43:01.765Z\"}",
                                    "text": "2025-05-19",
                                    "column": {
                                        "title": "Due date",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": false
                                }
                            ],
                            "statusStyle": {
                                "color": "#df2f4a",
                                "fontWeight": 600
                            },
                            "images": [],
                            "thumb": null
                        },
                        {
                            "id": "1962649128",
                            "name": "Task 3",
                            "column_values": [
                                {
                                    "id": "project_owner",
                                    "value": null,
                                    "text": "",
                                    "column": {
                                        "title": "Owner",
                                        "settings_str": "{\"max_people_allowed\":\"0\"}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "project_status",
                                    "value": "{\"index\":1,\"post_id\":null,\"changed_at\":\"2023-04-27T16:16:13.187Z\"}",
                                    "text": "Done",
                                    "column": {
                                        "title": "Status",
                                        "settings_str": "{\"done_colors\":[1],\"color_mapping\":{\"8\":11,\"11\":8},\"labels\":{\"0\":\"Working on it\",\"1\":\"Done\",\"2\":\"Stuck\",\"5\":\"Not Started\"},\"labels_positions_v2\":{\"0\":1,\"1\":0,\"2\":2,\"5\":3},\"labels_colors\":{\"0\":{\"color\":\"#fdab3d\",\"border\":\"#e99729\",\"var_name\":\"orange\"},\"1\":{\"color\":\"#00c875\",\"border\":\"#00b461\",\"var_name\":\"green-shadow\"},\"2\":{\"color\":\"#df2f4a\",\"border\":\"#ce3048\",\"var_name\":\"red-shadow\"},\"5\":{\"color\":\"#c4c4c4\",\"border\":\"#b0b0b0\",\"var_name\":\"grey\"}}}"
                                    },
                                    "statusStyle": {
                                        "color": "#00c875",
                                        "fontWeight": 600
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "date",
                                    "value": "{\"date\":\"2025-05-18\",\"changed_at\":\"2023-11-08T17:42:23.641Z\"}",
                                    "text": "2025-05-18",
                                    "column": {
                                        "title": "Due date",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": false
                                }
                            ],
                            "statusStyle": {
                                "color": "#00c875",
                                "fontWeight": 600
                            },
                            "images": [],
                            "thumb": null
                        }
                    ]
                }
            },
            {
                "items_page": {
                    "items": [
                        {
                            "id": "1962603733",
                            "name": "Task 1",
                            "column_values": [
                                {
                                    "id": "project_owner",
                                    "value": "{\"changed_at\":\"2023-08-23T12:42:09.066Z\",\"personsAndTeams\":[{\"id\":76184316,\"kind\":\"person\"}]}",
                                    "text": "BK",
                                    "column": {
                                        "title": "Owner",
                                        "settings_str": "{\"max_people_allowed\":\"0\"}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "project_status",
                                    "value": "{\"index\":0,\"post_id\":null,\"changed_at\":\"2023-03-06T14:43:16.460Z\"}",
                                    "text": "Working on it",
                                    "column": {
                                        "title": "Status",
                                        "settings_str": "{\"done_colors\":[1],\"color_mapping\":{\"8\":11,\"11\":8},\"labels\":{\"0\":\"Working on it\",\"1\":\"Done\",\"2\":\"Stuck\",\"5\":\"Not Started\"},\"labels_positions_v2\":{\"0\":1,\"1\":0,\"2\":2,\"5\":3},\"labels_colors\":{\"0\":{\"color\":\"#fdab3d\",\"border\":\"#e99729\",\"var_name\":\"orange\"},\"1\":{\"color\":\"#00c875\",\"border\":\"#00b461\",\"var_name\":\"green-shadow\"},\"2\":{\"color\":\"#df2f4a\",\"border\":\"#ce3048\",\"var_name\":\"red-shadow\"},\"5\":{\"color\":\"#c4c4c4\",\"border\":\"#b0b0b0\",\"var_name\":\"grey\"}}}"
                                    },
                                    "statusStyle": {
                                        "color": "#fdab3d",
                                        "fontWeight": 600
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "date",
                                    "value": "{\"date\":\"2025-05-17\",\"changed_at\":\"2023-11-08T17:42:20.136Z\"}",
                                    "text": "2025-05-17",
                                    "column": {
                                        "title": "Due date",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": false
                                }
                            ],
                            "statusStyle": {
                                "color": "#fdab3d",
                                "fontWeight": 600
                            },
                            "images": [],
                            "thumb": null
                        },
                        {
                            "id": "1962603760",
                            "name": "Task 2",
                            "column_values": [
                                {
                                    "id": "project_owner",
                                    "value": null,
                                    "text": "",
                                    "column": {
                                        "title": "Owner",
                                        "settings_str": "{\"max_people_allowed\":\"0\"}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "project_status",
                                    "value": "{\"index\":1,\"post_id\":null,\"changed_at\":\"2023-04-27T16:16:13.187Z\"}",
                                    "text": "Done",
                                    "column": {
                                        "title": "Status",
                                        "settings_str": "{\"done_colors\":[1],\"color_mapping\":{\"8\":11,\"11\":8},\"labels\":{\"0\":\"Working on it\",\"1\":\"Done\",\"2\":\"Stuck\",\"5\":\"Not Started\"},\"labels_positions_v2\":{\"0\":1,\"1\":0,\"2\":2,\"5\":3},\"labels_colors\":{\"0\":{\"color\":\"#fdab3d\",\"border\":\"#e99729\",\"var_name\":\"orange\"},\"1\":{\"color\":\"#00c875\",\"border\":\"#00b461\",\"var_name\":\"green-shadow\"},\"2\":{\"color\":\"#df2f4a\",\"border\":\"#ce3048\",\"var_name\":\"red-shadow\"},\"5\":{\"color\":\"#c4c4c4\",\"border\":\"#b0b0b0\",\"var_name\":\"grey\"}}}"
                                    },
                                    "statusStyle": {
                                        "color": "#00c875",
                                        "fontWeight": 600
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "date",
                                    "value": "{\"date\":\"2025-05-18\",\"changed_at\":\"2023-11-08T17:42:23.641Z\"}",
                                    "text": "2025-05-18",
                                    "column": {
                                        "title": "Due date",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": false
                                }
                            ],
                            "statusStyle": {
                                "color": "#00c875",
                                "fontWeight": 600
                            },
                            "images": [],
                            "thumb": null
                        },
                        {
                            "id": "1962603784",
                            "name": "Task 3",
                            "column_values": [
                                {
                                    "id": "project_owner",
                                    "value": null,
                                    "text": "",
                                    "column": {
                                        "title": "Owner",
                                        "settings_str": "{\"max_people_allowed\":\"0\"}"
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "project_status",
                                    "value": "{\"index\":2,\"post_id\":null,\"changed_at\":\"2023-04-27T16:17:50.181Z\"}",
                                    "text": "Stuck",
                                    "column": {
                                        "title": "Status",
                                        "settings_str": "{\"done_colors\":[1],\"color_mapping\":{\"8\":11,\"11\":8},\"labels\":{\"0\":\"Working on it\",\"1\":\"Done\",\"2\":\"Stuck\",\"5\":\"Not Started\"},\"labels_positions_v2\":{\"0\":1,\"1\":0,\"2\":2,\"5\":3},\"labels_colors\":{\"0\":{\"color\":\"#fdab3d\",\"border\":\"#e99729\",\"var_name\":\"orange\"},\"1\":{\"color\":\"#00c875\",\"border\":\"#00b461\",\"var_name\":\"green-shadow\"},\"2\":{\"color\":\"#df2f4a\",\"border\":\"#ce3048\",\"var_name\":\"red-shadow\"},\"5\":{\"color\":\"#c4c4c4\",\"border\":\"#b0b0b0\",\"var_name\":\"grey\"}}}"
                                    },
                                    "statusStyle": {
                                        "color": "#df2f4a",
                                        "fontWeight": 600
                                    },
                                    "skipDisplayFile": false
                                },
                                {
                                    "id": "date",
                                    "value": "{\"date\":\"2025-05-19\",\"changed_at\":\"2023-11-08T17:43:01.765Z\"}",
                                    "text": "2025-05-19",
                                    "column": {
                                        "title": "Due date",
                                        "settings_str": "{\"hide_footer\":false}"
                                    },
                                    "skipDisplayFile": false
                                }
                            ],
                            "statusStyle": {
                                "color": "#df2f4a",
                                "fontWeight": 600
                            },
                            "images": [],
                            "thumb": null
                        }
                    ]
                }
            }
        ]
    },
    "extensions": {
        "request_id": "f308fb29-17d7-9a80-b3aa-6a6af1fa1c72"
    }
};
			mockItems = processItems(mockItems);
			setItems(mockItems);
			plotPins(mockItems);
			return;
		}

		monday.listen("context", async (res) => {
			const boardId = res.data.boardId;
			if (!boardId) return;
            console.log('Current board: ' + boardId);
			setCurrentBoardId(boardId);
			// Fetch boards first, then fetch items
			await fetchBoards();
			setLoading(true);
			await fetchItemsFromBoard(['current']);
			setLoading(false);
		});

		// Also fetch boards on component mount in case context is already available
		fetchBoards();
	}, []);

	const flyToItem = (id) => {
		const coords = markerCoords.current[id];
		if (coords && mapRef.current) {
			mapRef.current.flyTo({ center: coords, zoom: 17 });
		}
	};

	// Prepare dropdown options for board selection
	const boardOptions = [
		{ value: 'current', label: 'Current Board' },
		...boards?.map(board => ({
			value: board.id,
			label: board.name
		})),
		{ value: 'all', label: 'All Boards' }
	];

	return (
	<>
      <Flex style={{ height: "100%", width: "100%" }}>
		{/* Sidebar */}
		<Box width="25%" style={{ height: "100vh", display: 'flex', flexDirection: 'column', paddingLeft: "8px", paddingRight: "8px" }} backgroundColor="surface">
			<Box style={{ width: "100%", position: "relative", overflow: "visible", flexGrow : 1, paddingTop: "8px", paddingBottom: "8px" }}>
				<Dropdown
					placeholder="Select board"
					options={boardOptions}
					defaultValue={[boardOptions[0]]}
					onChange={handleBoardChange}
					multi
					multiline
					style={{ width: "100%" }}
				/>
			</Box>
			{/* Scrollable content (cards) */}
			<Box className="cards-container" scrollable={true} style={{ flexGrow: 1 }}>
				{items.map(item => {
					return (
						<div key={item.id} onClick={() => {
								setSelectedItemId(item.id);
								flyToItem(item.id);
							}}>
						<Box textColor="textColorOnInverted"
							padding='medium'
							rounded="small"
							className={`property-card ${selectedItemId === item.id ? 'selected' : ''}`}>
							<Box className="thumb-wrapper">
								{item.thumb ? (
									<img
										src={item.thumb}
										alt="Thumbnail"
										className="card-thumb"
										onClick={(e) => {
											e.stopPropagation();
											setGalleryImages(item.images);
											setCurrentIndex(0);
										}}/>
								) : (
									<Tooltip 
										content="Add a 'Files' column and upload images to display a photo gallery here."
										position="top">
										<div>
											<Box className="card-thumb no-photo">
												<Avatar
													src={photoPlaceholder}
													alt="No photo"
													size="large"
													type="img"
												/>
											</Box>
										</div>
									</Tooltip>
								)}
							</Box>
							
							<Box className="card-content">
								<Flex direction="row" align="start" justify="space-between" gap="medium" style={{ width: '100%' }}>
									{/* Address + Icon */}
									<Flex gap="small" align="start" style={{ flex: 1 }}>
										<Icon icon={Location} iconSize={22}/>
										<Text
												element="div"
												maxLines={2}
												color="onInverted"
												weight="bold"
												className="card-addr"
												style={{ wordBreak: 'break-word' }}>
											{item.parsedAddress || item.address}
										</Text>
									</Flex>

									{/* Checkbox */}
									<Tooltip content="Select for route planning or printing to PDF" position="top">
										<div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
											<Checkbox
												checked={selectedItems.has(item.id)}
												onChange={(e) => handleItemSelection(item.id, e.target.checked)}
											/>
										</div>
									</Tooltip>
								</Flex>
								
								<Text element="div" weight="bold" className="property-name" color="onInverted" style={{ marginBottom : "6px", marginTop : "6px"}}>
									{item.name}
								</Text>
								
								<Box className="item-details" marginTop="small">
									{item.nhoodCity && (
										<Flex justify="space-between"  style={{ marginBottom : "6px"}}>
											<Text size="small" weight="bold" style={{ color: 'var(--color-ui_grey)' }}>Nhood/City</Text>
											<Text size="small" color="onInverted">{item.nhoodCity}</Text>
										</Flex>
									)}
									
									{item.originalAddress && (
										<Flex justify="space-between"  style={{ marginBottom : "6px"}}>
											<Text size="small" weight="bold" style={{ color: 'var(--color-ui_grey)' }}>
												{item.addressColumnTitle}
											</Text>
											<Text size="small" color="onInverted">
												{item.originalAddress}
											</Text>
										</Flex>
									)}
									
									{item.column_values.map((col, idx) => (
										!col.skipDisplayFile && !col.column.title.match(/address/i) && (
											<Flex key={idx} justify="space-between" style={{ marginBottom : "6px"}}>
												<Text size="small" weight="bold" style={{ color: 'var(--color-ui_grey)' }}>{col.column.title}</Text>
												<Text 
													size="small" color="onInverted"
													style={col.statusStyle}>
													{autoFormat(col.text)}
												</Text>
											</Flex>
										)
									))}
								</Box>
							</Box>
						</Box>
						</div>
					);
				})}
			</Box>
			{/* Bottom buttons */}
			<Flex direction="row" align="start" justify="space-between" gap="small" style={{ width: '100%', paddingTop: "8px", paddingBottom: "8px" }}>
				<Box style={{ flex: 1 }}>
					<Tooltip content="Select at least one property using the checkboxes to plan a route." position="top">
					<Button
						onClick={handleRoutePlanning}
						kind="primary"
						size="medium"
						leftIcon={Country}
						color={selectedItems.size ? 'primary' : 'inverted'}
						style={{ width: '100%' }} // optional, if Button itself doesn't stretch
					>
						Route ({selectedItems.size})
					</Button>
					</Tooltip>
				</Box>

				<Box style={{ flex: 1 }}>
					<Tooltip content="Use the checkboxes to choose which properties to include in the PDF." position="top">
						<Button
							onClick={handlePDFGeneration}
							kind="primary"
							size="medium"
							leftIcon={PDF}
							color={selectedItems.size ? 'primary' : 'inverted'}
							style={{ width: '100%' }} // optional
						>
							PDF ({selectedItems.size})
						</Button>
					</Tooltip>
				</Box>

				<Box style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
					<IconButton
						icon={selectedItems.size ? Remove : Check} // swap with suitable icons
						onClick={() => {
							if (selectedItems.size) {
								setSelectedItems(new Set());
							} else {
								setSelectedItems(new Set(items.map(item => item.id)));
							}
						}}
						tooltipContent={selectedItems.size ? "Unselect all" : "Select all"}
						size="medium"
						kind="primary"
						color={selectedItems.size ? 'positive' : 'on-inverted-background'}
						customColor={selectedItems.size ? 'positive' : undefined}
					/>
				</Box>
			</Flex>
		</Box>

		{/* Map container */}
		<Box style={{ flexGrow: 1, height: "100vh", width: "75%" }}>
			<div ref={mapContainer} style={{ height: "100%", width: "100%" }}></div>
		</Box>
    </Flex>

	<Modal
			isOpen={galleryImages.length > 0}
			onRequestClose={() => setGalleryImages([])}
			className="modal"
			overlayClassName="overlay"
			contentLabel="Image Gallery">
			{galleryImages.length > 0 && (
				<div className="modal-content">
				<button className="close-btn" onClick={() => setGalleryImages([])}>×</button>
				<button className="nav-btn left" onClick={() => setCurrentIndex(i => (i - 1 + galleryImages.length) % galleryImages.length)}>‹</button>
				<img src={galleryImages[currentIndex]} alt="Gallery" className="gallery-image-large" />
				<button className="nav-btn right" onClick={() => setCurrentIndex(i => (i + 1) % galleryImages.length)}>›</button>
				</div>
			)}
		</Modal>
	</>
	);
}

export default App;