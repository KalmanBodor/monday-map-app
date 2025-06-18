import './polyfills'; // Import polyfills first
import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import mondaySdk from "monday-sdk-js";
import Modal from 'react-modal';
import {
	Button,
	ButtonGroup,
	Dropdown,
	Checkbox,
	Text,
	Label,
	Loader,
	Icon,
	Tooltip,
	Avatar,
	Flex,
	Box
} from '@vibe/core';
import { PDF,Country } from '@vibe/icons';
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
	const [loading, setLoading] = useState(true);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [selectedItemId, setSelectedItemId] = useState(null);
	const [hoveredItem, setHoveredItem] = useState(null);
	const [galleryImages, setGalleryImages] = useState([]);
	const [currentIndex, setCurrentIndex] = useState(0);
	
	// New state for board selection and route planning
	const [boards, setBoards] = useState([]);
	const [selectedBoard, setSelectedBoard] = useState('current');
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

	// Fetch items from selected board(s)
	const fetchItemsFromBoard = async (boardSelections, currentBoard = null) => {
		try {
			if (boardSelections.length === 0) return;

			// Format board IDs properly for GraphQL query
			const boardIdsString = boardSelections.join(',');

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
			
			let allItems = [];
			response?.data?.boards?.forEach(board => {
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
		fetchItemsFromBoard(values, currentBoardId).finally(() => setLoading(false));
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
		monday.listen("context", async (res) => {
			const boardId = res.data.boardId;
			if (!boardId) return;

			setCurrentBoardId(boardId);
			// Fetch boards first, then fetch items
			await fetchBoards();
			setLoading(true);
			await fetchItemsFromBoard(['current'], boardId);
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

	// Find selected option for dropdown
	const selectedOption = boardOptions.find(option => option.value === selectedBoard);

	return (
      <Flex style={{ height: "100%", width: "100%" }}>
		{/* Sidebar */}
		<Box
			width="25%"
			padding="small"
			
			style={{ height: "100vh" }}
			>
			<Flex direction="row" gap={2}>
				<Tooltip content="Select at least one property using the checkboxes to plan a route." position="top">
					<Button
						onClick={handleRoutePlanning}
						kind="primary"
						size="medium"
						leftIcon={Country}
						color="inverted"
					>
						Route ({selectedItems.size})
					</Button>
				</Tooltip>

				<Tooltip content="Use the checkboxes to choose which properties to include in the PDF." position="top">
					<Button
						onClick={handlePDFGeneration}
						size="medium"
						kind="primary"
						leftIcon={PDF}
						color="inverted"
					>
						PDF ({selectedItems.size})
					</Button>
				</Tooltip>
			</Flex>
			<Box style={{ width: "100%", position: "relative", overflow: "visible" }}>
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
			<Box className="cards-container" padding="small">
				{items.map(item => {
					return (
						<Box 
							key={item.id}
							className={`property-card ${selectedItemId === item.id ? 'selected' : ''}`}
							onClick={() => {
								setSelectedItemId(item.id);
								flyToItem(item.id);
							}}
						>
							<Box>
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
											}}
										/>
									) : (
										<Tooltip 
											content="Add a 'Files' column and upload images to display a photo gallery here."
											position="top"
										>
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
									<Text 
										element="div" 
										className="card-addr"
										color="secondary"
									>
										{item.parsedAddress || item.address}
									</Text>
									
									<Flex align="center" gap="small" marginTop="xs">
										<Tooltip 
											content="Select for route planning or printing to PDF"
											position="top"
										>
											<div>
												<Checkbox
													checked={selectedItems.has(item.id)}
													onChange={(checked) => handleItemSelection(item.id, checked)}
													onClick={(e) => e.stopPropagation()}
												/>
											</div>
										</Tooltip>
									</Flex>
									
									<Text element="div" weight="bold" className="property-name">
										{item.name}
									</Text>
									
									<Box className="item-details" marginTop="small">
										{item.nhoodCity && (
											<Flex justify="space-between" marginBottom="xs">
												<Text size="small" color="secondary">Nhood/City</Text>
												<Text size="small">{item.nhoodCity}</Text>
											</Flex>
										)}
										
										{item.originalAddress && (
											<Flex justify="space-between" marginBottom="xs">
												<Text size="small" color="secondary">{item.addressColumnTitle}</Text>
												<Text size="small">{item.originalAddress}</Text>
											</Flex>
										)}
										
										{item.column_values.map((col, idx) => (
											!col.skipDisplayFile && !col.column.title.match(/address/i) && (
												<Flex key={idx} justify="space-between" marginBottom="xs">
													<Text size="small" color="secondary">{col.column.title}</Text>
													<Text 
														size="small" 
														style={col.statusStyle}
													>
														{autoFormat(col.text)}
													</Text>
												</Flex>
											)
										))}
									</Box>
								</Box>
							</Box>
						</Box>
					);
				})}
			</Box>
		</Box>

		{/* Map container */}
		<Box style={{ flexGrow: 1, height: "100vh", width: "75%" }}>
			<div ref={mapContainer} style={{ height: "100%", width: "100%" }}></div>
		</Box>
    </Flex>
	);
}

export default App;