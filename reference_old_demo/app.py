"""
Flask webapp for image annotation using Gemini 3.0 Flash.
Users can upload images and ask questions - Gemini responds with
both text answers and SVG annotations overlaid on the image.
"""

from prompts import SYSTEM_PROMPT
from llm_interface import call_openrouter, call_google_gemini

import os
import base64
import json
import re
from flask import Flask, render_template, request, jsonify, session
from werkzeug.utils import secure_filename
from PIL import Image, ImageDraw, ImageFont
import io
import uuid
import math

app = Flask(__name__)
app.secret_key = os.urandom(24)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max

# Ensure upload folder exists
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

def encode_image_to_base64(image_path):
    """Read image and encode to base64."""
    with open(image_path, 'rb') as f:
        return base64.b64encode(f.read()).decode('utf-8')


def get_image_dimensions(image_path):
    """Get image width and height."""
    with Image.open(image_path) as img:
        return img.size


def render_annotations_on_image(image_path, annotations, dimensions):
    """Render SVG annotations onto an image using PIL and return as bytes."""
    img = Image.open(image_path).convert('RGBA')

    # Create a transparent overlay for drawing
    overlay = Image.new('RGBA', img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    width, height = dimensions['width'], dimensions['height']

    def scale_x(val):
        return int((val / 1000) * width)

    def scale_y(val):
        return int((val / 1000) * height)

    def scale_size(val):
        avg_dim = (width + height) / 2
        return int((val / 1000) * avg_dim)

    def parse_color(color_str):
        """Parse hex color to RGB tuple."""
        if not color_str:
            return (255, 0, 0)
        color_str = color_str.lstrip('#')
        return tuple(int(color_str[i:i+2], 16) for i in (0, 2, 4))

    for ann in annotations:
        ann_type = ann.get('type')
        color = parse_color(ann.get('color', '#FF0000'))
        stroke_width = ann.get('strokeWidth', 3)

        try:
            if ann_type == 'number':
                x, y = scale_x(ann['x']), scale_y(ann['y'])
                r = scale_size(25)
                # Draw filled circle
                draw.ellipse([x - r, y - r, x + r, y + r], fill=color + (230,))
                # Draw number text
                try:
                    font = ImageFont.truetype("/System/Library/Fonts/Arial.ttf", int(r * 1.2))
                except:
                    font = ImageFont.load_default()
                text = str(ann['value'])
                bbox = draw.textbbox((x, y), text, font=font, anchor='mm')
                draw.text((x, y), text, fill=(255, 255, 255, 255), font=font, anchor='mm')

            elif ann_type == 'text':
                x, y = scale_x(ann['x']), scale_y(ann['y'])
                font_size = scale_size(ann.get('fontSize', 20))
                try:
                    font = ImageFont.truetype("/System/Library/Fonts/Arial.ttf", font_size)
                except:
                    font = ImageFont.load_default()
                text = ann.get('content', '')
                # Draw text with black outline using stroke parameters
                draw.text((x, y), text, fill=color + (255,), font=font,
                         stroke_width=3, stroke_fill=(0, 0, 0, 255))

            elif ann_type == 'circle':
                cx, cy = scale_x(ann['cx']), scale_y(ann['cy'])
                r = scale_size(ann['r'])
                draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color + (255,), width=stroke_width)

            elif ann_type == 'rect':
                x, y = scale_x(ann['x']), scale_y(ann['y'])
                w, h = scale_x(ann['width']), scale_y(ann['height'])
                draw.rectangle([x, y, x + w, y + h], outline=color + (255,), width=stroke_width)

            elif ann_type == 'arrow':
                x1, y1 = scale_x(ann['x1']), scale_y(ann['y1'])
                x2, y2 = scale_x(ann['x2']), scale_y(ann['y2'])
                # Draw line
                draw.line([(x1, y1), (x2, y2)], fill=color + (255,), width=stroke_width)
                # Draw arrowhead
                angle = math.atan2(y2 - y1, x2 - x1)
                head_length = scale_size(20)
                head_angle = math.pi / 6
                x3 = x2 - head_length * math.cos(angle - head_angle)
                y3 = y2 - head_length * math.sin(angle - head_angle)
                x4 = x2 - head_length * math.cos(angle + head_angle)
                y4 = y2 - head_length * math.sin(angle + head_angle)
                draw.polygon([(x2, y2), (x3, y3), (x4, y4)], fill=color + (255,))

            elif ann_type == 'polygon':
                points = [(scale_x(p[0]), scale_y(p[1])) for p in ann['points']]
                draw.polygon(points, outline=color + (255,), width=stroke_width)

            elif ann_type == 'path':
                # Simple path parsing - extract coordinates and draw lines
                d = ann.get('d', '')
                # Parse path commands (simplified - handles M, L, basic commands)
                import re
                coords = re.findall(r'[-+]?\d*\.?\d+', d)
                if len(coords) >= 4:
                    points = []
                    for i in range(0, len(coords) - 1, 2):
                        points.append((scale_x(float(coords[i])), scale_y(float(coords[i + 1]))))
                    if len(points) >= 2:
                        draw.line(points, fill=color + (255,), width=stroke_width)
        except Exception as e:
            # Skip annotations that fail to render
            print(f"Failed to render annotation {ann_type}: {e}")
            continue

    # Composite the overlay onto the original image
    img = Image.alpha_composite(img, overlay)
    img = img.convert('RGB')

    # Convert to bytes
    buffer = io.BytesIO()
    img.save(buffer, format='JPEG', quality=90)
    buffer.seek(0)
    return buffer.read()


def parse_gemini_response(response_text):
    """Parse Gemini's JSON response to extract answer and annotations.

    This function is robust and can extract JSON from various formats:
    - Pure JSON
    - JSON wrapped in markdown code blocks (```json ... ```)
    - JSON embedded in surrounding text
    """
    # Handle None or non-string responses
    if response_text is None:
        return {
            'answer': 'Error: Gemini returned an empty response. Please try again.',
            'annotations': [],
            'parse_error': 'Response was None'
        }
    if not isinstance(response_text, str):
        response_text = str(response_text)

    # Strategy 1: Try to find JSON in markdown code blocks
    json_match = re.search(r'```(?:json)?\s*(.*?)\s*```', response_text, re.DOTALL)
    if json_match:
        json_str = json_match.group(1)
        try:
            data = json.loads(json_str)
            return {
                'answer': data.get('answer', 'No answer provided'),
                'annotations': data.get('annotations', [])
            }
        except json.JSONDecodeError:
            pass  # Try next strategy

    # Strategy 2: Try to find JSON object anywhere in the text (look for {...})
    # Find the outermost JSON object by matching braces
    brace_match = re.search(r'\{(?:[^{}]|(?:\{[^{}]*\}))*\}', response_text, re.DOTALL)
    if brace_match:
        json_str = brace_match.group(0)
        try:
            data = json.loads(json_str)
            # Verify it has the expected structure
            if 'answer' in data or 'annotations' in data:
                return {
                    'answer': data.get('answer', 'No answer provided'),
                    'annotations': data.get('annotations', [])
                }
        except json.JSONDecodeError:
            pass  # Try next strategy

    # Strategy 3: Try parsing the entire response as JSON (after cleaning)
    json_str = response_text.strip()
    # Remove any markdown code block markers
    json_str = re.sub(r'^```\w*\n?', '', json_str)
    json_str = re.sub(r'\n?```$', '', json_str)
    try:
        data = json.loads(json_str)
        return {
            'answer': data.get('answer', 'No answer provided'),
            'annotations': data.get('annotations', [])
        }
    except json.JSONDecodeError:
        pass  # Fall through to error handling

    # Strategy 4: Look for more complex nested JSON (recursive brace matching)
    # Count braces to find the full JSON object even with nested structures
    start_idx = response_text.find('{')
    if start_idx != -1:
        brace_count = 0
        in_string = False
        escape_next = False

        for i in range(start_idx, len(response_text)):
            char = response_text[i]

            if escape_next:
                escape_next = False
                continue

            if char == '\\':
                escape_next = True
                continue

            if char == '"':
                in_string = not in_string
                continue

            if not in_string:
                if char == '{':
                    brace_count += 1
                elif char == '}':
                    brace_count -= 1
                    if brace_count == 0:
                        # Found complete JSON object
                        json_str = response_text[start_idx:i+1]
                        try:
                            data = json.loads(json_str)
                            if 'answer' in data or 'annotations' in data:
                                return {
                                    'answer': data.get('answer', 'No answer provided'),
                                    'annotations': data.get('annotations', [])
                                }
                        except json.JSONDecodeError:
                            pass
                        break

    # If all parsing strategies fail, return the raw text as answer with no annotations
    return {
        'answer': response_text,
        'annotations': [],
        'parse_error': 'Could not extract valid JSON from response'
    }


@app.route('/')
def index():
    """Render the main page."""
    return render_template('index.html')


@app.route('/list-images')
def list_images():
    """List all images in the uploads folder with thumbnail URLs."""
    upload_folder = app.config['UPLOAD_FOLDER']
    if not os.path.exists(upload_folder):
        return jsonify({'images': []})

    # Get all image files
    image_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'}
    images = []
    for filename in os.listdir(upload_folder):
        ext = os.path.splitext(filename)[1].lower()
        if ext in image_extensions:
            images.append({
                'filename': filename,
                'thumbnail_url': f'/thumbnail/{filename}'
            })

    # Sort by modification time (newest first)
    images.sort(key=lambda x: os.path.getmtime(os.path.join(upload_folder, x['filename'])), reverse=True)

    return jsonify({'images': images})


@app.route('/thumbnail/<filename>')
def get_thumbnail(filename):
    """Generate and serve a thumbnail for an image."""
    from flask import send_file

    # Security: prevent directory traversal
    filename = secure_filename(filename)
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)

    if not os.path.exists(filepath):
        return jsonify({'error': 'Image not found'}), 404

    try:
        # Open image and create thumbnail
        img = Image.open(filepath)
        img.thumbnail((100, 100), Image.Resampling.LANCZOS)

        # Save to bytes buffer
        buffer = io.BytesIO()
        img_format = img.format if img.format else 'JPEG'
        img.save(buffer, format=img_format, quality=85)
        buffer.seek(0)

        # Determine mimetype
        ext = os.path.splitext(filepath)[1].lower()
        mimetype = 'image/jpeg' if ext in ['.jpg', '.jpeg'] else 'image/png'

        return send_file(buffer, mimetype=mimetype)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/load-image/<filename>')
def load_image(filename):
    """Load a specific image from the uploads folder."""
    # Security: prevent directory traversal
    filename = secure_filename(filename)
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)

    if not os.path.exists(filepath):
        return jsonify({'error': 'Image not found'}), 404

    # Get dimensions
    width, height = get_image_dimensions(filepath)

    # Store in session and clear conversation history
    session['original_image'] = filepath
    session['current_image'] = filepath
    session['image_dimensions'] = {'width': width, 'height': height}
    session['conversation_history'] = []
    session['all_annotations'] = []
    session['annotation_counts'] = []

    # Return base64 encoded image
    img_base64 = encode_image_to_base64(filepath)
    ext = os.path.splitext(filepath)[1].lower()
    mime_type = 'image/jpeg' if ext in ['.jpg', '.jpeg'] else 'image/png'

    return jsonify({
        'success': True,
        'image_data': f"data:{mime_type};base64,{img_base64}",
        'dimensions': {'width': width, 'height': height}
    })


@app.route('/load-default')
def load_default_image():
    """Load the default sample image."""
    default_path = os.path.join(os.path.dirname(__file__), 'uploads', 'fruit.jpg')

    if not os.path.exists(default_path):
        return jsonify({'error': 'No default image'}), 404

    # Get dimensions
    width, height = get_image_dimensions(default_path)

    # Store in session and clear conversation history
    session['original_image'] = default_path
    session['current_image'] = default_path
    session['image_dimensions'] = {'width': width, 'height': height}
    session['conversation_history'] = []
    session['all_annotations'] = []
    session['annotation_counts'] = []

    # Return base64 encoded image
    img_base64 = encode_image_to_base64(default_path)

    return jsonify({
        'success': True,
        'image_data': f"data:image/jpeg;base64,{img_base64}",
        'dimensions': {'width': width, 'height': height}
    })


@app.route('/upload', methods=['POST'])
def upload_image():
    """Handle image upload."""
    if 'image' not in request.files:
        return jsonify({'error': 'No image provided'}), 400

    file = request.files['image']
    if file.filename == '':
        return jsonify({'error': 'No image selected'}), 400

    # Generate unique filename
    ext = os.path.splitext(file.filename)[1]
    filename = f"{uuid.uuid4()}{ext}"
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)

    file.save(filepath)

    # Get image dimensions
    width, height = get_image_dimensions(filepath)

    # Store in session and clear conversation history
    session['original_image'] = filepath
    session['current_image'] = filepath
    session['image_dimensions'] = {'width': width, 'height': height}
    session['conversation_history'] = []
    session['all_annotations'] = []
    session['annotation_counts'] = []

    # Return base64 encoded image for display
    img_base64 = encode_image_to_base64(filepath)
    mime_type = 'image/jpeg' if ext.lower() in ['.jpg', '.jpeg'] else 'image/png'

    return jsonify({
        'success': True,
        'image_data': f"data:{mime_type};base64,{img_base64}",
        'dimensions': {'width': width, 'height': height}
    })


@app.route('/ask', methods=['POST'])
def ask_question():
    """Process a question about the current image."""
    data = request.get_json()
    question = data.get('question', '')
    provider = data.get('provider', 'google')  # 'google' or 'openrouter'
    model = data.get('model', 'google/gemini-3-flash-preview')  # model for openrouter
    api_key = data.get('api_key', '')

    if not question:
        return jsonify({'error': 'No question provided'}), 400

    if not api_key:
        return jsonify({'error': 'No API key provided'}), 400

    original_image = session.get('original_image')
    if not original_image or not os.path.exists(original_image):
        return jsonify({'error': 'No image uploaded'}), 400

    dimensions = session.get('image_dimensions', {'width': 800, 'height': 600})

    # Get conversation history and accumulated annotations from session
    conversation_history = session.get('conversation_history', [])
    all_annotations = session.get('all_annotations', [])

    try:
        # If there are existing annotations, render them onto the original image
        # This way Gemini sees its previous annotations
        rasterized_image_base64 = None
        if all_annotations:
            image_bytes = render_annotations_on_image(original_image, all_annotations, dimensions)
            mime_type = 'image/jpeg'
            # Save rasterized image for debugging display
            rasterized_image_base64 = base64.b64encode(image_bytes).decode('utf-8')
        else:
            # No annotations yet, use original image
            with open(original_image, 'rb') as f:
                image_bytes = f.read()
            ext = os.path.splitext(original_image)[1].lower()
            mime_type = 'image/jpeg' if ext in ['.jpg', '.jpeg'] else 'image/png'

        # Prepare the prompt
        user_prompt = f"""User question: {question}

Remember to respond with valid JSON containing both "answer" and "annotations" fields. Use the normalized 0-1000 coordinate system for all annotation positions.

If you use a color in any annotation, wrap the matching phrase(s) in the answer with: <span style='color:#RRGGBB'>...</span> using the exact same hex color."""


        # Call the appropriate API based on provider
        if provider == 'openrouter':
            image_base64 = base64.b64encode(image_bytes).decode('utf-8')
            response_text = call_openrouter(api_key, image_base64, mime_type, SYSTEM_PROMPT, user_prompt, model, conversation_history)
        else:  # google
            # For Google provider, use the model from the request or default
            google_model = model if model else 'gemini-3.0-flash'
            response_text = call_google_gemini(api_key, image_bytes, mime_type, SYSTEM_PROMPT, user_prompt, google_model, conversation_history)

        # Parse the response
        result = parse_gemini_response(response_text)

        # Update conversation history
        conversation_history.append({"role": "user", "content": user_prompt})
        conversation_history.append({"role": "assistant", "content": response_text})
        session['conversation_history'] = conversation_history

        # Add new annotations to accumulated list and track as a group for undo
        if result.get('annotations'):
            all_annotations.extend(result['annotations'])
            session['all_annotations'] = all_annotations
            # Track how many annotations were added (for undo)
            annotation_counts = session.get('annotation_counts', [])
            annotation_counts.append(len(result['annotations']))
            session['annotation_counts'] = annotation_counts

            # Update rasterized image with new annotations
            image_bytes = render_annotations_on_image(original_image, all_annotations, dimensions)
            rasterized_image_base64 = base64.b64encode(image_bytes).decode('utf-8')

        return jsonify({
            'success': True,
            'answer': result['answer'],
            'annotations': result['annotations'],
            'rasterized_image': f"data:image/jpeg;base64,{rasterized_image_base64}" if rasterized_image_base64 else None,
            'raw_response': response_text if 'parse_error' in result else None
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/undo', methods=['POST'])
def undo_last():
    """Remove the last conversation exchange and annotations."""
    conversation_history = session.get('conversation_history', [])
    all_annotations = session.get('all_annotations', [])
    annotation_counts = session.get('annotation_counts', [])

    # Remove last user and assistant messages (2 messages)
    if len(conversation_history) >= 2:
        conversation_history = conversation_history[:-2]
        session['conversation_history'] = conversation_history

    # Remove last group of annotations
    if annotation_counts:
        count_to_remove = annotation_counts.pop()
        all_annotations = all_annotations[:-count_to_remove] if count_to_remove > 0 else all_annotations
        session['all_annotations'] = all_annotations
        session['annotation_counts'] = annotation_counts

    return jsonify({'success': True})


@app.route('/update-annotation', methods=['POST'])
def update_annotation():
    """Update a specific annotation's coordinates."""
    data = request.get_json()
    index = data.get('index')
    updated_data = data.get('annotation')

    if index is None or updated_data is None:
        return jsonify({'error': 'Missing index or annotation data'}), 400

    all_annotations = session.get('all_annotations', [])

    if index < 0 or index >= len(all_annotations):
        return jsonify({'error': 'Invalid annotation index'}), 400

    # Update the annotation at the specified index
    all_annotations[index] = updated_data
    session['all_annotations'] = all_annotations

    return jsonify({'success': True})


@app.route('/delete-annotation', methods=['POST'])
def delete_annotation():
    """Delete a specific annotation."""
    data = request.get_json()
    index = data.get('index')

    if index is None:
        return jsonify({'error': 'Missing index'}), 400

    all_annotations = session.get('all_annotations', [])
    annotation_counts = session.get('annotation_counts', [])

    if index < 0 or index >= len(all_annotations):
        return jsonify({'error': 'Invalid annotation index'}), 400

    # Remove the annotation at the specified index
    all_annotations.pop(index)
    session['all_annotations'] = all_annotations

    # Update annotation_counts to reflect the deletion
    # This is a simplified approach - for more complex undo, we'd need to track which group the annotation belonged to
    if annotation_counts:
        # Decrease the last group count
        annotation_counts[-1] = max(0, annotation_counts[-1] - 1)
        session['annotation_counts'] = annotation_counts

    return jsonify({'success': True})


@app.route('/add-annotation', methods=['POST'])
def add_annotation():
    """Add a user-drawn annotation."""
    data = request.get_json()
    annotation = data.get('annotation')

    if annotation is None:
        return jsonify({'error': 'Missing annotation data'}), 400

    all_annotations = session.get('all_annotations', [])
    annotation_counts = session.get('annotation_counts', [])

    # Add the annotation
    all_annotations.append(annotation)
    session['all_annotations'] = all_annotations

    # Track for undo (treat each user-drawn annotation as its own group)
    annotation_counts.append(1)
    session['annotation_counts'] = annotation_counts

    return jsonify({'success': True})


@app.route('/clear', methods=['POST'])
def clear_session():
    """Clear the current session but keep the uploaded image."""
    # Preserve image data
    current_image = session.get('current_image')
    image_filename = session.get('image_filename')
    image_dimensions = session.get('image_dimensions')

    # Clear everything
    session.clear()

    # Restore image data
    if current_image:
        session['current_image'] = current_image
    if image_filename:
        session['image_filename'] = image_filename
    if image_dimensions:
        session['image_dimensions'] = image_dimensions

    return jsonify({'success': True})


@app.route('/clear-user-annotations', methods=['POST'])
def clear_user_annotations():
    """Clear only user-drawn annotations."""
    all_annotations = session.get('all_annotations', [])

    # Filter out annotations with source='user'
    all_annotations = [ann for ann in all_annotations if ann.get('source') != 'user']
    session['all_annotations'] = all_annotations

    return jsonify({'success': True})


@app.route('/clear-annotations', methods=['POST'])
def clear_all_annotations():
    """Clear all annotations (user + AI)."""
    session['all_annotations'] = []
    session['annotation_counts'] = []
    return jsonify({'success': True})


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5001)
    args = parser.parse_args()
    app.run(debug=True, port=args.port)
