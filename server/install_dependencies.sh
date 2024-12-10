#!/bin/bash

STORAGE_DIR=/opt/render/project/.render

if [[ ! -d $STORAGE_DIR/chrome ]]; then
  echo "...Downloading Chrome"
  mkdir -p $STORAGE_DIR/chrome
  cd $STORAGE_DIR/chrome
  wget -P ./ https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  dpkg -x ./google-chrome-stable_current_amd64.deb $STORAGE_DIR/chrome
  rm ./google-chrome-stable_current_amd64.deb
  cd $HOME/project/src || exit 1 # Make sure we return to where we were
else
  echo "...Using Chrome from cache"
fi

# Add Chrome's location to the PATH
export PATH="${PATH}:/opt/render/project/.render/chrome/opt/google/chrome"

# Install Node.js dependencies
echo "Installing Node.js dependencies..."
yarn install

# Navigate to scripts directory (under server)
cd server/scripts || { echo "scripts directory not found"; exit 1; }

# Check Python version
python3 --version 

# Upgrade pip in the virtual environment
echo "Upgrading pip in the virtual environment..."
/opt/render/project/src/.venv/bin/python -m pip install --upgrade pip

# Install Python dependencies
echo "Installing Python dependencies..."
pip3 install -r requirements.txt || { echo "requirements.txt not found"; exit 1; }

# Navigate back to server directory
cd ../..
