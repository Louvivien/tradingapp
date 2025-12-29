#!/bin/bash


STORAGE_DIR=/opt/render/project/.render

if [[ ! -d $STORAGE_DIR/chrome ]]; then
  echo "...Downloading Chrome"
  mkdir -p $STORAGE_DIR/chrome
  cd $STORAGE_DIR/chrome
  wget -P ./ https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  dpkg -x ./google-chrome-stable_current_amd64.deb $STORAGE_DIR/chrome
  rm ./google-chrome-stable_current_amd64.deb
  cd $HOME/project/src # Make sure we return to where we were
else
  echo "...Using Chrome from cache"
fi

# be sure to add Chromes location to the PATH as part of your Start Command
# export PATH="${PATH}:/opt/render/project/.render/chrome/opt/google/chrome"

# install node modules
echo "Installing Node.js dependencies..."
export YARN_CACHE_FOLDER="${YARN_CACHE_FOLDER:-/opt/render/project/.cache/yarn}"
yarn install --frozen-lockfile --production --prefer-offline

# navigate to scripts directory
cd scripts

# Check Python version
python3 --version 

# install python packages
echo "Installing Python dependencies..."
export PIP_CACHE_DIR="${PIP_CACHE_DIR:-/opt/render/project/.cache/pip}"
export PIP_DISABLE_PIP_VERSION_CHECK=1
pip3 install -r requirements.txt --upgrade-strategy only-if-needed

# navigate back to server directory
cd ..
