// Polyfills for @vibe/core compatibility with React 18

// Global polyfill
if (typeof global === 'undefined') {
  window.global = window;
}

// ReactDOM.findDOMNode polyfill for React 18 compatibility
import ReactDOM from 'react-dom';

// Only add polyfill if findDOMNode doesn't exist
if (!ReactDOM.findDOMNode) {
  ReactDOM.findDOMNode = function(component) {
    // This is a simplified polyfill
    // For production use, you might want a more robust implementation
    if (component && component._reactInternalFiber) {
      let node = component._reactInternalFiber;
      while (node) {
        if (node.stateNode && node.stateNode.nodeType) {
          return node.stateNode;
        }
        node = node.child;
      }
    }
    if (component && component.nodeType) {
      return component;
    }
    return null;
  };
}